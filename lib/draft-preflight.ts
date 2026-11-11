/**
 * Pre-flight for draft product creation: re-captures the favorites-only
 * candidates from Kelme (DB writes only — NEVER writes Shopify), then
 * evaluates each against lib/shopify-draft-plan.ts's evaluatePreflight and
 * renders a report. Kelme calls go through lib/kelme.ts, i.e. the same
 * DB-backed token load/persist path the worker uses, so a token Kelme rolls
 * forward mid-run is saved for the worker's session too.
 */
import { readFile, writeFile } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { shopifyGraphQL } from "@/lib/shopify";
import { checkImageExists } from "@/lib/kelme";
import { captureProduct, pullProductDeclaration } from "@/lib/kelme-capture";
import { captureProductAttributes } from "@/lib/kelme-attributes";
import { getDbTarget } from "@/lib/shopify-reconcile";
import { dryRunRelink } from "@/lib/shopify-relink";
import { titleHasStyleCode } from "@/lib/style-match";
import { EXCLUDED_NOTE_PREFIX } from "@/lib/size-config";
import { evaluatePreflight, type PreflightResult } from "@/lib/shopify-draft-plan";

const CALL_PACING_MS = 400;
export const REPORT_MD = path.join(process.cwd(), "draft-preflight-report.md");
export const REPORT_JSON = path.join(process.cwd(), "draft-preflight.json");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ShopifyTitleRow {
  id: string;
  title: string;
  status: string;
}

const TITLES_QUERY = `
  query draftTitles($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node { id title status } }
    }
  }
`;

export async function fetchShopifyTitles(): Promise<ShopifyTitleRow[]> {
  const rows: ShopifyTitleRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const res: { data?: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; edges: { node: ShopifyTitleRow }[] } }; errors?: { message: string }[] } =
      await shopifyGraphQL(TITLES_QUERY, { cursor });
    if (res.errors?.length) throw new Error(`products title query error: ${JSON.stringify(res.errors)}`);
    const page = res.data!.products;
    rows.push(...page.edges.map((e) => e.node));
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return rows;
}

// Sibling DB style codes sharing a stem ("K16XLQC026" / "K16XLQC026-1") and
// Shopify products (any status) whose title already claims this code.
export function familyConflictsFor(
  styleCode: string,
  allDbStyleCodes: string[],
  shopifyTitles: ShopifyTitleRow[],
): string[] {
  const stem = styleCode.replace(/-\d{1,2}$/, "");
  const out: string[] = [];
  const siblings = allDbStyleCodes.filter((c) => c !== styleCode && c.replace(/-\d{1,2}$/, "") === stem);
  if (siblings.length > 0) out.push(`sibling DB codes: ${siblings.join(", ")}`);
  for (const t of shopifyTitles) {
    if (titleHasStyleCode(t.title, styleCode)) out.push(`already on Shopify (${t.status}): "${t.title}"`);
  }
  return out;
}

// Re-captures one product from Kelme into the DB (Product, Variants, colors/
// sizes declaration, attributes) and drops variant rows outside the freshly
// declared colors × sizes. Kelme calls ride lib/kelme.ts's DB-backed token
// path. Throws on a dead Kelme session so callers can stop the run.
export async function recaptureProduct(c: { id: number; pdtid: number; styleCode: string }): Promise<{ dropNotes: string[]; excludedNotes: string[]; error?: string }> {
  const cap = await captureProduct(c.pdtid);
  const dropNotes = cap.warnings.filter((w) => /allow-list|unmapped size/.test(w));
  // Policy-excluded sizes (lib/size-config.ts) are "not sold": reported, never a blocker.
  const excludedNotes = cap.warnings.filter((w) => w.startsWith(EXCLUDED_NOTE_PREFIX));
  if (!cap.ok) return { dropNotes, excludedNotes, error: cap.error ?? "capture failed" };
  await sleep(CALL_PACING_MS);
  const decl = await pullProductDeclaration(c.pdtid, c.styleCode);
  if (decl.ok) {
    // Variants are DERIVED from the declaration: drop rows outside the
    // freshly declared colors × sizes (stale combos).
    await prisma.variant.deleteMany({
      where: {
        productId: c.id,
        OR: [{ colorCode: { notIn: decl.colorsWritten.map((x) => x.colorCode) } }, { shopifySize: { notIn: decl.sizesWritten } }],
      },
    });
  }
  await sleep(CALL_PACING_MS);
  await captureProductAttributes(c.pdtid);
  return { dropNotes, excludedNotes };
}

export interface PreflightRun {
  generatedAt: string;
  captured: boolean;
  excludedUnlisted: { styleCode: string; title: string; status: string }[];
  captureErrors: { styleCode: string; error: string }[];
  stoppedEarly: string | null;
  results: PreflightResult[];
}

export async function runPreflight(opts: { capture: boolean; only?: string[]; knownDropNotes?: Map<string, string[]>; knownExcludedNotes?: Map<string, string[]> }): Promise<PreflightRun> {
  const [relink, titles, allProducts] = await Promise.all([
    dryRunRelink(),
    fetchShopifyTitles(),
    prisma.product.findMany({ select: { styleCode: true } }),
  ]);
  const allDbStyleCodes = allProducts.map((p) => p.styleCode);
  const unlistedCodes = new Set(relink.unlistedProducts.map((u) => u.styleCode));

  let candidates = await prisma.product.findMany({
    where: { onShopify: false },
    orderBy: { styleCode: "asc" },
    select: { id: true, pdtid: true, styleCode: true },
  });
  candidates = candidates.filter((c) => !unlistedCodes.has(c.styleCode));
  if (opts.only?.length) candidates = candidates.filter((c) => opts.only!.includes(c.styleCode));

  const run: PreflightRun = {
    generatedAt: new Date().toISOString(),
    captured: opts.capture,
    excludedUnlisted: relink.unlistedProducts.map((u) => ({ styleCode: u.styleCode, title: u.title, status: u.status })),
    captureErrors: [],
    stoppedEarly: null,
    results: [],
  };
  // Dropped sizes are only observable during a capture; without one, reuse the
  // notes recorded by the last --capture run rather than silently treating
  // every product as having none.
  const dropNotes = new Map<string, string[]>(opts.knownDropNotes ?? []);
  const excludedNotes = new Map<string, string[]>(opts.knownExcludedNotes ?? []);

  if (opts.capture) {
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      console.log(`[preflight] recapture (${i + 1}/${candidates.length}) ${c.styleCode} pdtid=${c.pdtid}`);
      try {
        const rc = await recaptureProduct(c);
        dropNotes.set(c.styleCode, rc.dropNotes);
        excludedNotes.set(c.styleCode, rc.excludedNotes);
        if (rc.error) run.captureErrors.push({ styleCode: c.styleCode, error: rc.error });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        run.captureErrors.push({ styleCode: c.styleCode, error: message });
        if (message.includes("session expired")) {
          run.stoppedEarly = "Kelme session expired — stopped; remaining candidates not re-captured";
          break;
        }
      }
      await sleep(CALL_PACING_MS);
    }
  }

  for (const c of candidates) {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: c.id },
      include: { variants: { select: { colorCode: true, shopifySize: true, imageUrl: true } } },
    });
    const dbTarget = await getDbTarget(product.styleCode);
    const colorsMissingGid = [...new Set(dbTarget?.target.filter((t) => !t.colorGid).map((t) => t.colorCode) ?? [])];
    const sizesMissingGid =
      dbTarget && dbTarget.sizeOptionName !== null ? [...new Set(dbTarget.target.filter((t) => !t.sizeGid).map((t) => t.size))] : [];

    const input = {
      styleCode: product.styleCode,
      name: product.name,
      gender: product.gender,
      subCategory: product.subCategory,
      kelmeCatalogPrice: product.kelmeCatalogPrice,
      mainpic: product.mainpic,
      variants: product.variants,
      droppedSizeNotes: dropNotes.get(product.styleCode) ?? [],
      excludedSizeNotes: excludedNotes.get(product.styleCode) ?? [],
      colorsMissingGid,
      sizesMissingGid,
      familyConflicts: familyConflictsFor(product.styleCode, allDbStyleCodes, titles),
      unreachableImages: [] as string[],
    };
    let result = evaluatePreflight(input);

    // Reachability only matters for products that would otherwise pass.
    if (result.clean) {
      const seen = new Map<string, string>();
      for (const v of product.variants) if (v.imageUrl && !seen.has(v.colorCode)) seen.set(v.colorCode, v.imageUrl);
      for (const [colorCode, url] of seen) {
        if (!(await checkImageExists(url))) input.unreachableImages.push(colorCode);
      }
      result = evaluatePreflight(input);
    }
    run.results.push(result);
  }

  return run;
}

// Dropped-size notes recorded by the last `preflight --capture` run.
export async function loadRecordedDropNotes(): Promise<{ notes: Map<string, string[]>; excluded: Map<string, string[]>; generatedAt: string }> {
  let raw: string;
  try {
    raw = await readFile(REPORT_JSON, "utf8");
  } catch {
    throw new Error("draft-preflight.json not found — run `npm run drafts -- preflight --capture` first");
  }
  const run = JSON.parse(raw) as PreflightRun;
  if (!run.captured) throw new Error("draft-preflight.json was not produced by a --capture run — re-run `preflight --capture`");
  return {
    notes: new Map(run.results.map((r) => [r.styleCode, r.droppedSizeNotes])),
    excluded: new Map(run.results.map((r) => [r.styleCode, r.excludedSizeNotes ?? []])),
    generatedAt: run.generatedAt };
}

export function renderReport(run: PreflightRun): string {
  const clean = run.results.filter((r) => r.clean);
  const spike = run.results.filter((r) => r.simpleApparel && r.variantCount < 100);
  const lines: string[] = [];
  lines.push(`# Draft pre-flight report`);
  lines.push(``);
  lines.push(`Generated ${run.generatedAt} — re-captured from Kelme: ${run.captured ? "yes (DB only)" : "NO (stale DB state)"}`);
  if (run.stoppedEarly) lines.push(`\n**STOPPED EARLY:** ${run.stoppedEarly}`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(`- Candidates (favorites-only, onShopify=false, excl. UNLISTED): **${run.results.length}**`);
  lines.push(`- Clean (no flags): **${clean.length}**  — of which simple apparel (spike-eligible): **${spike.length}**`);
  lines.push(`- Flagged: **${run.results.length - clean.length}**`);
  lines.push(`- Needs split (>100 variants): ${run.results.filter((r) => r.needsSplit).length}`);
  lines.push(`- No variants after capture: ${run.results.filter((r) => r.variantCount === 0).length}`);
  lines.push(`- Products with policy-excluded sizes (not sold, not a blocker): ${run.results.filter((r) => (r.excludedSizeNotes ?? []).length > 0).length}`);
  lines.push(`- Products with dropped sizes: ${run.results.filter((r) => r.droppedSizeNotes.length > 0).length}`);
  lines.push(`- Products with colors lacking shopifyGid: ${run.results.filter((r) => r.colorsMissingGid.length > 0).length}`);
  lines.push(`- Style-code family conflicts: ${run.results.filter((r) => r.familyConflicts.length > 0).length}`);
  lines.push(`- Products missing images: ${run.results.filter((r) => r.colorsMissingImage.length > 0).length}`);
  lines.push(`- No category mapping: ${run.results.filter((r) => !r.category).length}`);
  lines.push(``);
  lines.push(`## Excluded: exist on Shopify as UNLISTED (${run.excludedUnlisted.length})`);
  for (const u of run.excludedUnlisted) lines.push(`- ${u.styleCode} (${u.status}) — ${u.title}`);
  if (run.captureErrors.length > 0) {
    lines.push(``);
    lines.push(`## Capture errors (${run.captureErrors.length})`);
    for (const e of run.captureErrors) lines.push(`- ${e.styleCode}: ${e.error}`);
  }
  lines.push(``);
  lines.push(`## Spike-eligible (clean simple apparel, <100 variants)`);
  if (spike.length === 0) lines.push(`_none_`);
  for (const r of spike) {
    lines.push(`- **${r.styleCode}** — ${r.name} — ${r.audience} — ${r.variantCount} variants (${r.colorCount} colors × ${r.sizes.join("/")}) — ${r.category?.label}`);
  }
  lines.push(``);
  lines.push(`## All candidates`);
  lines.push(`| styleCode | name | audience | variants | sizes | dropped sizes | colors w/o GID | split | family | no image | category | status |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of run.results) {
    lines.push(
      `| ${r.styleCode} | ${r.name.trim()} | ${r.audience} | ${r.variantCount} | ${r.sizes.join("/")} | ${r.droppedSizeNotes.length} | ${r.colorsMissingGid.join(",") || "-"} | ${r.needsSplit ? "YES" : "-"} | ${r.familyConflicts.length > 0 ? "YES" : "-"} | ${r.colorsMissingImage.length > 0 ? r.colorsMissingImage.join(",") : "-"} | ${r.category ? r.category.label.split(" > ").slice(-1)[0] : "NONE"} | ${r.clean ? (r.simpleApparel ? "CLEAN (apparel)" : "clean") : "FLAGGED"} |`,
    );
  }
  lines.push(``);
  lines.push(`## Flag detail`);
  for (const r of run.results.filter((x) => !x.clean)) {
    lines.push(`### ${r.styleCode} — ${r.name.trim()}`);
    for (const f of r.flags) lines.push(`- ${f}`);
    for (const d of r.droppedSizeNotes) lines.push(`  - dropped: ${d}`);
  }
  return lines.join("\n") + "\n";
}

export async function writeReport(run: PreflightRun): Promise<void> {
  await writeFile(REPORT_MD, renderReport(run), "utf8");
  await writeFile(REPORT_JSON, JSON.stringify(run, null, 2), "utf8");
}

