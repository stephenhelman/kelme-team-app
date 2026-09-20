/**
 * Stages 1–2 of .claude/docs/SPRINT_INVENTORY_PUSH.md: live Kelme pull ->
 * DB catch-up. Read-Kelme + write-DB(qty only) — never touches Shopify,
 * SKUs, or variant structure. Stage 3 (DB -> Shopify) lives in
 * lib/shopify-inventory-push.ts.
 *
 * This is deliberately the same shape as lib/kelme-capture.ts's
 * captureAllFavorites/rebuildAllVariants — the automatic worker wraps
 * pullLiveStock + applyStockToDb directly, no rewrite.
 */
import { prisma } from "@/lib/prisma";
import { fetchSkuSheet } from "@/lib/kelme";
import { parseSkuSheet } from "@/lib/stock";
import { buildDeclaredVariants, type DeclaredVariant } from "@/lib/kelme-capture";

const CALL_PACING_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDeadTokenError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("session expired");
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isDeadTokenError(err)) throw err;
    await sleep(CALL_PACING_MS);
    return await fn();
  }
}

// Same isBallProduct heuristic duplicated across lib/shopify-reconcile.ts,
// lib/shopify-sku.ts, lib/kelme-capture.ts — kept local rather than
// imported so each module's Kelme/Shopify dependency stays minimal.
const NON_BALL_QUALIFIERS = /\b(set|shorts|shirt|socks|bag|net|board)\b/i;
function isBallProduct(name: string): boolean {
  return /ball/i.test(name) && !NON_BALL_QUALIFIERS.test(name);
}

export interface PulledVariantStock extends DeclaredVariant {
  productDbId: number;
  pdtid: number;
  styleCode: string;
}

export interface PullStockReport {
  totalProducts: number;
  okProducts: number;
  pulled: PulledVariantStock[];
  totalQtyPulled: number;
  variantsWithStock: number;
  variantsZero: number;
  maxSingleQty: number;
  failed: { pdtid: number; styleCode: string; error: string }[];
  stoppedEarly: boolean;
  stopReason?: string;
}

// Stage 1 — live pull only, no DB writes. Every onShopify:true product gets
// its sku-sheet re-fetched fresh; a per-product failure (other than dead
// token) just excludes that product from `pulled` — its DB qty is left
// untouched downstream, never zeroed by a failed read.
export async function pullLiveStock(): Promise<PullStockReport> {
  const products = await prisma.product.findMany({
    where: { onShopify: true },
    select: { id: true, pdtid: true, styleCode: true, name: true },
    orderBy: { id: "asc" },
  });
  const allowedSizes = new Set((await prisma.size.findMany({ select: { shopifySize: true } })).map((s) => s.shopifySize));

  const report: PullStockReport = {
    totalProducts: products.length,
    okProducts: 0,
    pulled: [],
    totalQtyPulled: 0,
    variantsWithStock: 0,
    variantsZero: 0,
    maxSingleQty: 0,
    failed: [],
    stoppedEarly: false,
  };

  for (let i = 0; i < products.length; i++) {
    const { id, pdtid, styleCode, name } = products[i];
    console.log(`[kelme-inventory] pull (${i + 1}/${products.length}) pdtid ${pdtid} (${styleCode})...`);
    try {
      const sheet = await withRetry(() => fetchSkuSheet(pdtid));
      const { entries } = parseSkuSheet(sheet, styleCode);
      const isBall = isBallProduct(name);
      const declared = buildDeclaredVariants(entries, isBall, allowedSizes);

      for (const d of declared) {
        report.pulled.push({ productDbId: id, pdtid, styleCode, ...d });
        report.totalQtyPulled += d.qty;
        if (d.qty > 0) report.variantsWithStock += 1;
        else report.variantsZero += 1;
        if (d.qty > report.maxSingleQty) report.maxSingleQty = d.qty;
      }
      report.okProducts += 1;
    } catch (err) {
      if (isDeadTokenError(err)) {
        report.stoppedEarly = true;
        report.stopReason = "Kelme session expired — stopped, existing DB data left untouched";
        console.error(`[kelme-inventory] ${report.stopReason}`);
        break;
      }
      report.failed.push({ pdtid, styleCode, error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(CALL_PACING_MS);
  }

  console.log(
    `[kelme-inventory] PULL complete okProducts=${report.okProducts}/${report.totalProducts} ` +
      `variants=${report.pulled.length} totalQty=${report.totalQtyPulled} failed=${report.failed.length}` +
      (report.stoppedEarly ? ` STOPPED EARLY: ${report.stopReason}` : ""),
  );

  return report;
}

// A stable, human-picked sample spread across the pulled list (not just the
// first N) so a garbage/all-zero pull can't hide behind a lucky front page.
export function sampleStock(report: PullStockReport, count = 12): PulledVariantStock[] {
  if (report.pulled.length <= count) return report.pulled;
  const step = report.pulled.length / count;
  const sample: PulledVariantStock[] = [];
  for (let i = 0; i < count; i++) sample.push(report.pulled[Math.floor(i * step)]);
  return sample;
}

const SANITY_MIN_RATIO = 0.5; // pulled total must be at least half of the current DB total, else halt

export interface ApplyStockResult {
  halted: boolean;
  haltReason?: string;
  pullReport: Omit<PullStockReport, "pulled">;
  currentDbTotalQty: number;
  pulledTotalQty: number;
  matched: number;
  updated: number;
  unmatched: { productDbId: number; styleCode: string; colorCode: string; shopifySize: string; qty: number }[];
  distribution: { zero: number; oneToFive: number; sixToTwenty: number; over20: number };
}

// Stage 2 — re-pulls fresh (Stage 1 is read-only and cheap to repeat; this
// keeps the two stages independently callable without threading state
// through an HTTP boundary) and, if the sanity bound clears, writes qty onto
// EXISTING Variant rows only. A declared (color, size) with no matching DB
// variant is reported in `unmatched`, never created — this stage only
// catches the DB up on qty, it never rebuilds variant structure.
export async function applyStockToDb(): Promise<ApplyStockResult> {
  const pullReport = await pullLiveStock();
  const { pulled, ...pullSummary } = pullReport;

  const dbVariants = await prisma.variant.findMany({
    where: { product: { onShopify: true } },
    select: { id: true, productId: true, colorCode: true, shopifySize: true, qty: true },
  });
  const currentDbTotalQty = dbVariants.reduce((sum, v) => sum + v.qty, 0);
  const pulledTotalQty = pullReport.totalQtyPulled;

  if (currentDbTotalQty > 20 && pulledTotalQty < currentDbTotalQty * SANITY_MIN_RATIO) {
    const haltReason =
      `pulled total qty (${pulledTotalQty}) is less than ${SANITY_MIN_RATIO * 100}% of the current DB total ` +
      `(${currentDbTotalQty}) — suspect partial/broken pull, halted without writing`;
    console.error(`[kelme-inventory] HALTED: ${haltReason}`);
    return {
      halted: true,
      haltReason,
      pullReport: pullSummary,
      currentDbTotalQty,
      pulledTotalQty,
      matched: 0,
      updated: 0,
      unmatched: [],
      distribution: { zero: 0, oneToFive: 0, sixToTwenty: 0, over20: 0 },
    };
  }

  const dbByKey = new Map(dbVariants.map((v) => [`${v.productId}::${v.colorCode}::${v.shopifySize}`, v]));
  const unmatched: ApplyStockResult["unmatched"] = [];
  const distribution = { zero: 0, oneToFive: 0, sixToTwenty: 0, over20: 0 };
  let matched = 0;
  let updated = 0;

  for (const p of pulled) {
    const key = `${p.productDbId}::${p.colorCode}::${p.shopifySize}`;
    const existing = dbByKey.get(key);
    if (!existing) {
      unmatched.push({ productDbId: p.productDbId, styleCode: p.styleCode, colorCode: p.colorCode, shopifySize: p.shopifySize, qty: p.qty });
      continue;
    }
    matched += 1;
    if (p.qty === 0) distribution.zero += 1;
    else if (p.qty <= 5) distribution.oneToFive += 1;
    else if (p.qty <= 20) distribution.sixToTwenty += 1;
    else distribution.over20 += 1;

    if (existing.qty !== p.qty) {
      await prisma.variant.update({ where: { id: existing.id }, data: { qty: p.qty } });
      updated += 1;
    }
  }

  console.log(
    `[kelme-inventory] APPLY complete matched=${matched} updated=${updated} unmatched=${unmatched.length} ` +
      `currentDbTotalQty(before)=${currentDbTotalQty} pulledTotalQty=${pulledTotalQty}`,
  );

  return {
    halted: false,
    pullReport: pullSummary,
    currentDbTotalQty,
    pulledTotalQty,
    matched,
    updated,
    unmatched,
    distribution,
  };
}
