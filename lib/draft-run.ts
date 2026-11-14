/**
 * Favorites -> Shopify drafts, for every favorite that is not on Shopify yet.
 * One engine for the manual command (`drafts create --all`) and the daily
 * worker job (lib/auto-drafts.ts), so both apply the same rules.
 *
 *   plan  (dry-run)  reads Kelme live + Shopify titles + the DB — writes NOTHING
 *   run   (execute)  per style: ensure DB capture -> DraftJob lock -> executeDraft -> verify
 *
 * Stops only on an API/Shopify failure (a person decides what next; nothing is
 * retried automatically). A style that is merely blocked (unknown size label,
 * nothing to create ...) is recorded and the run moves on.
 */
import { prisma } from "@/lib/prisma";
import { fetchFavoritesPage, fetchProductAttributes, fetchProductDetail, fetchSkuSheet } from "@/lib/kelme";
import { parseSkuSheet } from "@/lib/stock";
import { buildColorImageMap, captureProduct, isBallProduct } from "@/lib/kelme-capture";
import { mapAttributes } from "@/lib/kelme-attributes";
import { classifySize, sellableApparelLabels, ONE_SIZE_LABEL } from "@/lib/size-config";
import { fetchShopifyTitles } from "@/lib/draft-preflight";
import { titleHasStyleCode } from "@/lib/style-match";
import { evaluateDraft, type CategoryMap, type DraftEvaluation, type DraftSource } from "@/lib/draft-rules";
import { fetchLiveCategoryMap } from "@/lib/draft-category";
import { createDraftTracked, type JobOutcome } from "@/lib/draft-jobs";
import type { DraftEmailItem } from "@/lib/draft-email";
import { describeMissingColors, missingColorCodes, type MissingColor } from "@/lib/color-seed";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (String(e).includes("session expired")) throw e;
    await sleep(800);
    return await fn();
  }
}

export interface Favorite {
  id: number; // Kelme pdtid
  no: string; // style code
  note: string; // name
}

export async function fetchFavorites(): Promise<Favorite[]> {
  const favs: Favorite[] = [];
  for (let start = 0; ; start += 60) {
    const page = await retry(() => fetchFavoritesPage(start, 60));
    favs.push(...page.products.map((p) => ({ id: p.id, no: p.no, note: p.note ?? "" })));
    if (start + 60 >= page.total || page.products.length === 0) break;
    await sleep(400);
  }
  return favs;
}

// --- Selection (pure) ----------------------------------------------------------

export interface SelectionContext {
  onShopify: (styleCode: string) => boolean; // any status incl. UNLISTED, or DB onShopify
  jobStatus: Map<string, string>; // DraftJob.status by style code
}

export interface Selection {
  pending: Favorite[]; // to create now (after the cap)
  overCap: Favorite[]; // eligible but beyond the cap — left for the next run
  needsHuman: { styleCode: string; status: string }[]; // CREATING/FAILED from an earlier run
  alreadyOnShopify: number;
}

export function selectPending(favs: Favorite[], ctx: SelectionContext, cap?: number): Selection {
  const eligible: Favorite[] = [];
  const needsHuman: Selection["needsHuman"] = [];
  let already = 0;
  for (const f of [...favs].sort((a, b) => a.no.localeCompare(b.no))) {
    const st = ctx.jobStatus.get(f.no);
    if (st === "CREATED" || ctx.onShopify(f.no)) {
      already++;
      continue;
    }
    if (st === "CREATING" || st === "FAILED") {
      needsHuman.push({ styleCode: f.no, status: st });
      continue;
    }
    eligible.push(f); // no job, or BLOCKED (re-evaluated)
  }
  const n = cap === undefined ? eligible.length : Math.max(0, cap);
  return { pending: eligible.slice(0, n), overCap: eligible.slice(n), needsHuman, alreadyOnShopify: already };
}

export async function loadSelection(favs: Favorite[], cap?: number): Promise<Selection> {
  const [titles, dbOn, jobs] = await Promise.all([
    fetchShopifyTitles(),
    prisma.product.findMany({ where: { onShopify: true }, select: { styleCode: true } }),
    prisma.draftJob.findMany({ select: { styleCode: true, status: true } }).catch((e: { code?: string }) => {
      if (e?.code === "P2021") {
        console.warn("WARNING: the DraftJob table does not exist yet — run `npx prisma migrate deploy` before --execute. (Dry-run continues with no job history.)");
        return [] as { styleCode: string; status: string }[];
      }
      throw e;
    }),
  ]);
  const dbOnSet = new Set(dbOn.map((p) => p.styleCode));
  return selectPending(
    favs,
    { onShopify: (code) => dbOnSet.has(code) || titles.some((t) => titleHasStyleCode(t.title, code)), jobStatus: new Map(jobs.map((j) => [j.styleCode, j.status])) },
    cap,
  );
}

// --- Dry-run: build a DraftSource straight from Kelme, no DB writes -----------------

export async function liveDraftSource(f: Favorite): Promise<DraftSource> {
  const sheet = await retry(() => fetchSkuSheet(f.id));
  await sleep(350);
  const attrs = await retry(() => fetchProductAttributes(f.id));
  await sleep(350);
  const detail = await retry(() => fetchProductDetail(f.id));
  await sleep(350);
  const { entries } = parseSkuSheet(sheet, f.no);
  const a = mapAttributes(attrs);
  const isBall = isBallProduct(f.note);
  const sellable = new Set([...sellableApparelLabels(), ONE_SIZE_LABEL]);

  const carried = new Map<string, { colorCode: string; colorName: string; size: string; qty: number }>();
  const leftOff: DraftSource["leftOff"] = [];
  const unknown: string[] = [];
  for (const e of entries) {
    if (!e.colorCode) continue;
    const c = classifySize(e.kelmeSize, isBall);
    if (c.status === "excluded") leftOff.push({ size: c.kelmeSize, colorCode: e.colorCode, qty: e.qty });
    else if (c.status === "unknown") unknown.push(c.kelmeSize);
    else if (isBall || sellable.has(c.shopifySize)) carried.set(`${e.colorCode}::${c.shopifySize}`, { colorCode: e.colorCode, colorName: e.colorName, size: c.shopifySize, qty: e.qty });
    else unknown.push(e.kelmeSize);
  }
  const codes = [...new Set([...carried.values()].map((v) => v.colorCode))];
  const images = buildColorImageMap(detail.allpic, f.no, new Set(codes));
  const [colorRows, sizeRows] = await Promise.all([
    prisma.color.findMany({ where: { colorCode: { in: codes } } }),
    prisma.size.findMany({ where: { shopifySize: { in: [...new Set([...carried.values()].map((v) => v.size))] } } }),
  ]);
  const colorGid = new Map(colorRows.map((c) => [c.colorCode, c.shopifyGid]));
  const sizeGid = new Map(sizeRows.map((s) => [s.shopifySize, isBall ? s.ballSizeGid : s.shopifyGid]));
  const sizes = [...new Set([...carried.values()].map((v) => v.size))];
  const noSizeDimension = sizes.length === 1 && sizes[0] === ONE_SIZE_LABEL;

  return {
    styleCode: f.no,
    name: f.note,
    gender: a.gender,
    subCategory: a.subCategory,
    kelmeCatalogPrice: typeof detail.price === "number" ? detail.price : null,
    variants: [...carried.values()].map((v) => ({ ...v, imageUrl: images.get(v.colorCode) ?? null })),
    leftOff,
    unknownSizes: unknown,
    colorsMissingGid: codes.filter((c) => !colorGid.get(c)),
    sizesMissingGid: noSizeDimension ? [] : sizes.filter((s) => !sizeGid.get(s)),
  };
}

export interface PlannedDraft {
  favorite: Favorite;
  source: DraftSource;
  evaluation: DraftEvaluation;
  totalQty: number;
  error?: string;
}

export async function planDrafts(pending: Favorite[], categoryMap: CategoryMap, onProgress?: (i: number, n: number) => void): Promise<PlannedDraft[]> {
  const out: PlannedDraft[] = [];
  for (let i = 0; i < pending.length; i++) {
    const f = pending[i];
    try {
      const source = await liveDraftSource(f);
      out.push({ favorite: f, source, evaluation: evaluateDraft(source, categoryMap), totalQty: source.variants.reduce((n, v) => n + v.qty, 0) });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      out.push({ favorite: f, source: null as unknown as DraftSource, evaluation: null as unknown as DraftEvaluation, totalQty: 0, error: message });
      if (message.includes("session expired")) break;
    }
    onProgress?.(i + 1, pending.length);
  }
  return out;
}

/** What the vendor email would show for a planned draft (preview only — no Shopify product exists yet). */
export function previewEmailItem(p: PlannedDraft): DraftEmailItem {
  return {
    title: p.evaluation.title,
    styleCode: p.favorite.no,
    shopifyProductId: "gid://shopify/Product/0",
    colors: p.evaluation.colors.map((c) => c.name),
    sizes: p.evaluation.sizesCreated,
    sizesNotOffered: p.evaluation.sizesLeftOff,
    todos: p.evaluation.todos,
  };
}

// --- Execute ----------------------------------------------------------------------

export interface RunReport {
  runId: number;
  source: "manual" | "auto";
  pending: number;
  created: JobOutcome[];
  blocked: JobOutcome[];
  failed: JobOutcome[];
  skipped: JobOutcome[];
  overCap: string[];
  needsHuman: { styleCode: string; status: string }[];
  stoppedReason: string | null;
  missingColors: MissingColor[]; // Kelme colors with no Shopify value: their styles stay blocked until seeded
}

async function ensureDbProduct(f: Favorite): Promise<void> {
  const have = await prisma.product.findFirst({ where: { styleCode: f.no }, select: { id: true } });
  if (have) return;
  const cap = await captureProduct(f.id); // upserts Product by pdtid (DB write; only ever called on --execute)
  if (!cap.ok) throw new Error(`Kelme re-capture failed: ${cap.error ?? "capture failed"}`);
}

export async function runDrafts(opts: { source: "manual" | "auto"; cap?: number; only?: string[]; runId?: number; log?: (m: string) => void }): Promise<RunReport> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const favs = await fetchFavorites();
  let sel = await loadSelection(favs, opts.cap);
  if (opts.only?.length) sel = { ...sel, pending: sel.pending.filter((f) => opts.only!.includes(f.no)) };
  const counts = { pending: sel.pending.length + sel.overCap.length, overCap: sel.overCap.length };
  // The daily job creates the run row BEFORE any network call (it doubles as the "attempted today" marker).
  const run = opts.runId ? await prisma.draftRun.update({ where: { id: opts.runId }, data: counts }) : await prisma.draftRun.create({ data: { source: opts.source, ...counts } });
  const report: RunReport = { runId: run.id, source: opts.source, pending: sel.pending.length + sel.overCap.length, created: [], blocked: [], failed: [], skipped: [], overCap: sel.overCap.map((f) => f.no), needsHuman: sel.needsHuman, stoppedReason: null, missingColors: [] };
  log(`run ${run.id} (${opts.source}): ${favs.length} favorites; not on Shopify ${report.pending}; creating ${sel.pending.length}; over cap ${sel.overCap.length}; needs a person ${sel.needsHuman.length}`);

  const categoryMap = await fetchLiveCategoryMap();
  for (let i = 0; i < sel.pending.length; i++) {
    const f = sel.pending[i];
    log(`\n===== [${i + 1}/${sel.pending.length}] ${f.no}`);
    let outcome: JobOutcome;
    try {
      await ensureDbProduct(f);
      outcome = await createDraftTracked(f.no, { runId: run.id, categoryMap });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      outcome = { styleCode: f.no, status: message.includes("session expired") ? "blocked" : "failed", message };
      if (message.includes("session expired")) report.stoppedReason = "Kelme session expired — re-auth required";
    }
    log(`${outcome.status.toUpperCase()} ${f.no}${outcome.message ? ` — ${outcome.message}` : ""}`);
    (outcome.status === "created" ? report.created : outcome.status === "blocked" ? report.blocked : outcome.status === "failed" ? report.failed : report.skipped).push(outcome);
    if (report.stoppedReason) break;
    if (outcome.status === "failed") {
      report.stoppedReason = `failure on ${f.no}: ${outcome.message ?? ""}`.slice(0, 500);
      break;
    }
    await sleep(1000);
  }

  report.missingColors = await describeMissingColors([...report.blocked, ...report.failed].flatMap((o) => missingColorCodes(o.message ?? ""))).catch(() => []);
  await prisma.draftRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), created: report.created.length, blocked: report.blocked.length, failed: report.failed.length, stoppedReason: report.stoppedReason },
  });
  return report;
}
