/**
 * Writes the correct SKU (buildSku(styleCode, colorCode, shopifySize)) to
 * every onShopify:true Shopify variant, from .claude/docs/SPRINT_SKU_WRITE.md.
 * Compute-and-write, not data correction — the catalog is already clean and
 * every onShopify:true DB variant has its shopifyVariantId from the relink
 * step.
 *
 * Three gated phases, meant to be run in order with human review between:
 *   - computeSkus     — read-only-ish. Computes + stores Variant.sku for
 *                       every onShopify:true variant, no Shopify calls.
 *   - dryRunWrite     — read-only against Shopify. Pulls each variant's
 *                       current SKU + owning product id via nodes(ids:),
 *                       diffs against the stored DB sku.
 *   - executeWrite    — writes only the mismatched variants via
 *                       productVariantsBulkUpdate (grouped by product,
 *                       chunked to 100/call), resumable via a per-variant
 *                       log file.
 *
 * Only the `sku` field (via ProductVariantsBulkInput.inventoryItem.sku) is
 * touched — no options, media, or variant structure. Low blast radius.
 */
import { appendFile, readFile } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { shopifyGraphQL } from "@/lib/shopify";
import { buildSku } from "@/lib/sku";

const CALL_PACING_MS = 400;
const WRITE_LOG_PATH = path.join(process.cwd(), "shopify-sku-write-log.jsonl");
const NODES_CHUNK = 250; // Shopify's nodes(ids:) practical batch size
const BULK_UPDATE_CHUNK = 100; // productVariantsBulkUpdate's per-call variant limit

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function shopifyVariantGid(id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/ProductVariant/${id}`;
}

// --- Variant classification for the sample report ---
// Same isBallProduct heuristic as lib/shopify-reconcile.ts, duplicated for
// the same reason (avoid pulling in unrelated modules for a 2-line check).
const NON_BALL_QUALIFIERS = /\b(set|shorts|shirt|socks|bag|net|board)\b/i;
function isBallProduct(name: string): boolean {
  return /ball/i.test(name) && !NON_BALL_QUALIFIERS.test(name);
}

export type VariantKind = "kids-apparel" | "adult-apparel" | "ball" | "one-size-equipment" | "other";

export function classifyVariantKind(shopifySize: string, productName: string): VariantKind {
  if (shopifySize === "One Size") return "one-size-equipment";
  if (isBallProduct(productName)) return "ball";
  if (/^\d+$/.test(shopifySize)) return "kids-apparel";
  if (/^(XS|S|M|L|X{0,2}L|\d+X?L)$/i.test(shopifySize)) return "adult-apparel";
  return "other";
}

// --- Phase 1: compute + store SKUs ---

export interface ComputeSkusSample {
  kind: VariantKind;
  styleCode: string;
  colorCode: string;
  shopifySize: string;
  sku: string;
}

export interface ComputeSkusResult {
  totalOnShopifyVariants: number;
  updated: number;
  alreadyCorrect: number;
  sample: ComputeSkusSample[];
}

const SAMPLE_KINDS: VariantKind[] = ["kids-apparel", "adult-apparel", "ball", "one-size-equipment"];

export async function computeSkus(): Promise<ComputeSkusResult> {
  const products = await prisma.product.findMany({
    where: { onShopify: true },
    select: {
      styleCode: true,
      name: true,
      variants: { select: { id: true, colorCode: true, shopifySize: true, sku: true } },
    },
  });

  let updated = 0;
  let alreadyCorrect = 0;
  const sampleByKind = new Map<VariantKind, ComputeSkusSample>();

  for (const product of products) {
    for (const variant of product.variants) {
      const sku = buildSku(product.styleCode, variant.colorCode, variant.shopifySize);

      if (variant.sku !== sku) {
        await prisma.variant.update({ where: { id: variant.id }, data: { sku } });
        updated += 1;
      } else {
        alreadyCorrect += 1;
      }

      const kind = classifyVariantKind(variant.shopifySize, product.name);
      if (SAMPLE_KINDS.includes(kind) && !sampleByKind.has(kind)) {
        sampleByKind.set(kind, { kind, styleCode: product.styleCode, colorCode: variant.colorCode, shopifySize: variant.shopifySize, sku });
      }
    }
  }

  const totalOnShopifyVariants = updated + alreadyCorrect;
  console.log(
    `[shopify-sku] COMPUTE total=${totalOnShopifyVariants} updated=${updated} alreadyCorrect=${alreadyCorrect}`,
  );

  return {
    totalOnShopifyVariants,
    updated,
    alreadyCorrect,
    sample: SAMPLE_KINDS.map((k) => sampleByKind.get(k)).filter((s): s is ComputeSkusSample => Boolean(s)),
  };
}

// --- Shared: pull DB onShopify:true variants + current Shopify state ---

interface DbVariantRow {
  id: number;
  sku: string;
  shopifyVariantId: string | null;
}

async function loadOnShopifyVariants(): Promise<DbVariantRow[]> {
  return prisma.variant.findMany({
    where: { product: { onShopify: true } },
    select: { id: true, sku: true, shopifyVariantId: true },
  });
}

interface VariantNodeResponse {
  nodes: ({ id: string; sku: string; product: { id: string } } | null)[];
}

const NODES_QUERY = `
  query variantNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      id
      ... on ProductVariant {
        sku
        product { id }
      }
    }
  }
`;

interface ShopifyVariantState {
  variantGid: string;
  currentSku: string;
  shopifyProductId: string;
}

async function fetchCurrentShopifyState(variantGids: string[]): Promise<Map<string, ShopifyVariantState>> {
  const result = new Map<string, ShopifyVariantState>();

  for (const batch of chunk(variantGids, NODES_CHUNK)) {
    const res = await shopifyGraphQL<VariantNodeResponse>(NODES_QUERY, { ids: batch });
    if (res.errors?.length) {
      throw new Error(`nodes(ids:) GraphQL error: ${JSON.stringify(res.errors)}`);
    }
    for (const node of res.data?.nodes ?? []) {
      if (!node) continue;
      result.set(node.id, { variantGid: node.id, currentSku: node.sku, shopifyProductId: node.product.id });
    }
    await sleep(CALL_PACING_MS);
  }

  return result;
}

// --- Phase 2: dry-run diff against live Shopify state ---

export interface DryRunWriteResult {
  totalOnShopifyVariants: number;
  nullShopifyVariantId: { variantId: number; sku: string }[];
  alreadyCorrect: number;
  toWrite: { variantId: number; variantGid: string; shopifyProductId: string; currentSku: string; targetSku: string }[];
  notFoundOnShopify: { variantId: number; variantGid: string }[];
}

export async function dryRunWrite(): Promise<DryRunWriteResult> {
  const variants = await loadOnShopifyVariants();

  const nullShopifyVariantId = variants
    .filter((v) => !v.shopifyVariantId)
    .map((v) => ({ variantId: v.id, sku: v.sku }));

  const withGid = variants.filter((v): v is DbVariantRow & { shopifyVariantId: string } => Boolean(v.shopifyVariantId));
  const gidByVariantId = new Map(withGid.map((v) => [v.id, shopifyVariantGid(v.shopifyVariantId)]));
  const allGids = [...gidByVariantId.values()];

  const currentState = await fetchCurrentShopifyState(allGids);

  let alreadyCorrect = 0;
  const toWrite: DryRunWriteResult["toWrite"] = [];
  const notFoundOnShopify: DryRunWriteResult["notFoundOnShopify"] = [];

  for (const v of withGid) {
    const gid = gidByVariantId.get(v.id)!;
    const state = currentState.get(gid);
    if (!state) {
      notFoundOnShopify.push({ variantId: v.id, variantGid: gid });
      continue;
    }
    if (state.currentSku === v.sku) {
      alreadyCorrect += 1;
      continue;
    }
    toWrite.push({
      variantId: v.id,
      variantGid: gid,
      shopifyProductId: state.shopifyProductId,
      currentSku: state.currentSku,
      targetSku: v.sku,
    });
  }

  const result: DryRunWriteResult = {
    totalOnShopifyVariants: variants.length,
    nullShopifyVariantId,
    alreadyCorrect,
    toWrite,
    notFoundOnShopify,
  };

  console.log(
    `[shopify-sku] DRY RUN total=${result.totalOnShopifyVariants} toWrite=${toWrite.length} ` +
      `alreadyCorrect=${alreadyCorrect} nullShopifyVariantId=${nullShopifyVariantId.length} notFound=${notFoundOnShopify.length}`,
  );

  return result;
}

// --- Phase 3: execute — grouped by product, chunked, resumable ---

const BULK_UPDATE_MUTATION = `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: true) {
      productVariants { id sku }
      userErrors { field message }
    }
  }
`;

interface BulkUpdateResponse {
  productVariantsBulkUpdate: {
    productVariants: { id: string; sku: string }[] | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

function isThrottled(message: string): boolean {
  return /throttled/i.test(message);
}

async function bulkUpdateWithBackoff(
  productId: string,
  variants: { id: string; inventoryItem: { sku: string } }[],
): Promise<BulkUpdateResponse["productVariantsBulkUpdate"]> {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await shopifyGraphQL<BulkUpdateResponse>(BULK_UPDATE_MUTATION, { productId, variants });

    if (res.errors?.length) {
      const message = JSON.stringify(res.errors);
      if (isThrottled(message) && attempt < maxAttempts - 1) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`productVariantsBulkUpdate GraphQL error: ${message}`);
    }

    const payload = res.data?.productVariantsBulkUpdate;
    if (!payload) throw new Error(`productVariantsBulkUpdate returned no payload: ${JSON.stringify(res)}`);
    if (payload.userErrors.length > 0) {
      throw new Error(`productVariantsBulkUpdate userErrors: ${JSON.stringify(payload.userErrors)}`);
    }
    return payload;
  }
  throw new Error(`productVariantsBulkUpdate on product=${productId} exhausted retries (still throttled)`);
}

export interface SkuWriteLogEntry {
  variantId: number;
  variantGid: string;
  shopifyProductId: string;
  sku: string;
  status: "ok" | "failed";
  message?: string;
  at: string;
}

async function loadCompletedVariantIds(): Promise<Set<number>> {
  const done = new Set<number>();
  try {
    const raw = await readFile(WRITE_LOG_PATH, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as SkuWriteLogEntry;
        if (entry.status === "ok") done.add(entry.variantId);
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // no log yet
  }
  return done;
}

async function appendLog(entries: SkuWriteLogEntry[]): Promise<void> {
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await appendFile(WRITE_LOG_PATH, lines, "utf8");
}

export interface ExecuteWriteReport {
  candidates: number;
  skippedAlreadyDone: number;
  processedThisRun: number;
  remaining: number;
  ok: number;
  failed: number;
  entries: SkuWriteLogEntry[];
}

// Processes at most `chunkSize` not-yet-logged variants per call (default:
// all of them), grouped by Shopify product and sent in batches of up to 100
// per productVariantsBulkUpdate call. Safe to call repeatedly — already-
// logged ("ok") variant ids are skipped, so a chunked run picks up where the
// last one left off.
export async function executeWrite(chunkSize?: number): Promise<ExecuteWriteReport> {
  const dryRun = await dryRunWrite();
  const completed = await loadCompletedVariantIds();

  const pending = dryRun.toWrite.filter((v) => !completed.has(v.variantId));
  const candidates = dryRun.toWrite.length;

  const report: ExecuteWriteReport = {
    candidates,
    skippedAlreadyDone: candidates - pending.length,
    processedThisRun: 0,
    remaining: 0,
    ok: 0,
    failed: 0,
    entries: [],
  };

  const toProcess = chunkSize !== undefined ? pending.slice(0, chunkSize) : pending;
  report.remaining = pending.length - toProcess.length;

  const byProduct = new Map<string, typeof toProcess>();
  for (const v of toProcess) {
    const group = byProduct.get(v.shopifyProductId) ?? [];
    group.push(v);
    byProduct.set(v.shopifyProductId, group);
  }

  for (const [shopifyProductId, group] of byProduct) {
    for (const batch of chunk(group, BULK_UPDATE_CHUNK)) {
      const at = new Date().toISOString();
      try {
        await bulkUpdateWithBackoff(
          shopifyProductId,
          batch.map((v) => ({ id: v.variantGid, inventoryItem: { sku: v.targetSku } })),
        );
        const entries: SkuWriteLogEntry[] = batch.map((v) => ({
          variantId: v.variantId,
          variantGid: v.variantGid,
          shopifyProductId,
          sku: v.targetSku,
          status: "ok",
          at,
        }));
        await appendLog(entries);
        report.entries.push(...entries);
        report.processedThisRun += batch.length;
        report.ok += batch.length;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const entries: SkuWriteLogEntry[] = batch.map((v) => ({
          variantId: v.variantId,
          variantGid: v.variantGid,
          shopifyProductId,
          sku: v.targetSku,
          status: "failed",
          message,
          at,
        }));
        await appendLog(entries);
        report.entries.push(...entries);
        report.processedThisRun += batch.length;
        report.failed += batch.length;
      }
      await sleep(CALL_PACING_MS);
    }
  }

  console.log(
    `[shopify-sku] EXECUTE candidates=${report.candidates} skipped=${report.skippedAlreadyDone} ` +
      `processedThisRun=${report.processedThisRun} remaining=${report.remaining} ok=${report.ok} failed=${report.failed}`,
  );

  return report;
}

// --- Phase 4: verify by re-pull ---

export interface VerifyResult {
  totalOnShopifyVariants: number;
  correct: number;
  mismatched: { variantId: number; variantGid: string; expectedSku: string; actualSku: string }[];
  placeholderOrNull: { variantId: number; variantGid: string; actualSku: string }[];
  nullShopifyVariantId: { variantId: number; sku: string }[];
  notFoundOnShopify: { variantId: number; variantGid: string }[];
}

export async function verifyWrite(): Promise<VerifyResult> {
  const variants = await loadOnShopifyVariants();

  const nullShopifyVariantId = variants
    .filter((v) => !v.shopifyVariantId)
    .map((v) => ({ variantId: v.id, sku: v.sku }));

  const withGid = variants.filter((v): v is DbVariantRow & { shopifyVariantId: string } => Boolean(v.shopifyVariantId));
  const gidByVariantId = new Map(withGid.map((v) => [v.id, shopifyVariantGid(v.shopifyVariantId)]));
  const currentState = await fetchCurrentShopifyState([...gidByVariantId.values()]);

  let correct = 0;
  const mismatched: VerifyResult["mismatched"] = [];
  const placeholderOrNull: VerifyResult["placeholderOrNull"] = [];
  const notFoundOnShopify: VerifyResult["notFoundOnShopify"] = [];

  for (const v of withGid) {
    const gid = gidByVariantId.get(v.id)!;
    const state = currentState.get(gid);
    if (!state) {
      notFoundOnShopify.push({ variantId: v.id, variantGid: gid });
      continue;
    }
    if (state.currentSku === v.sku) {
      correct += 1;
      continue;
    }
    mismatched.push({ variantId: v.id, variantGid: gid, expectedSku: v.sku, actualSku: state.currentSku });
    if (!state.currentSku || state.currentSku.startsWith("FG")) {
      placeholderOrNull.push({ variantId: v.id, variantGid: gid, actualSku: state.currentSku });
    }
  }

  const result: VerifyResult = {
    totalOnShopifyVariants: variants.length,
    correct,
    mismatched,
    placeholderOrNull,
    nullShopifyVariantId,
    notFoundOnShopify,
  };

  console.log(
    `[shopify-sku] VERIFY total=${result.totalOnShopifyVariants} correct=${correct} ` +
      `mismatched=${mismatched.length} placeholderOrNull=${placeholderOrNull.length} ` +
      `nullShopifyVariantId=${nullShopifyVariantId.length} notFound=${notFoundOnShopify.length}`,
  );

  return result;
}
