/**
 * The permanent Kelme capture module. Per-product capture is the core unit —
 * `captureProduct(pdtid)` pulls one product's detail + stock and upserts
 * Color/Product/Variant; `captureAllFavorites()` is just a paced loop over
 * it. Server-only (imports lib/kelme.ts, which requires KELME_TOKEN).
 *
 * NOT in this module: matching Variants to Shopify variantId/inventoryItemId
 * and pushing inventory. That's a separate, later step.
 */
import { prisma } from "@/lib/prisma";
import { buildSku } from "@/lib/sku";
import { parseSkuSheet } from "@/lib/stock";
import { fetchFavoritesPage, fetchProductDetail, fetchSkuSheet, type RawPriceListEntry, type RawProductDetail } from "@/lib/kelme";

const CALL_PACING_MS = 400;
const FAVORITES_PAGE_SIZE = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDeadTokenError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("000005");
}

// Retry once on transient failure; a dead token is never transient, so it
// propagates immediately without burning a retry.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isDeadTokenError(err)) throw err;
    await sleep(CALL_PACING_MS);
    return await fn();
  }
}

// Kids gear resolves to the EU size for the SKU/Shopify side; adults, balls,
// and one-size items keep their KELME value as-is. Never the raw cm, never US.
const KIDS_EU_SIZE_MAP: Record<string, string> = {
  "110cm": "4",
  "120cm": "6",
  "130cm": "8",
  "140cm": "10",
  "150cm": "12",
  "160cm": "14",
  "170cm": "16",
};

// Returns null for a cm size with no EU mapping — the caller must flag and
// skip that variant rather than fall back to the raw kelmeSize, which would
// leak an unresolved cm value into shopifySize/SKU.
function resolveShopifySize(kelmeSize: string): string | null {
  if (/^\d+cm$/.test(kelmeSize)) {
    return KIDS_EU_SIZE_MAP[kelmeSize] ?? null;
  }
  return kelmeSize;
}

// The FOB Xiamen unit cost lives in priceList as a named entry, not price.
function extractFobCost(priceList: RawPriceListEntry[] | undefined): number | null {
  const entry = priceList?.find((p) => typeof p.name === "string" && p.name.includes("Fob Xiamen"));
  if (!entry) return null;
  const value = Number(String(entry.value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function categoryIdsOf(detail: RawProductDetail): string {
  return Object.entries(detail)
    .filter(([key, value]) => /^m_dim\d+_id$/.test(key) && value)
    .map(([, value]) => String(value))
    .join(",");
}

// Associate allpic images strictly by the colorCode segment parsed from the
// filename ({styleCode}_{colorCode}_{seq}.jpg), restricted to colorCodes the
// stock sheet actually produced. That restriction is what filters out
// summary/hero images (bare {styleCode}.jpg, sentinel {styleCode}_9999.jpg)
// without guessing — they simply never match a known color. No HEAD-check;
// use whatever allpic contains, preferring the _01 sequence per color.
function buildColorImageMap(allpic: string[] | undefined, styleCode: string, knownCodes: Set<string>): Map<string, string> {
  const best = new Map<string, { seq: string; url: string }>();
  for (const url of allpic ?? []) {
    const filename = url.split("/").pop() ?? "";
    const parts = filename.replace(/\.[^.]+$/, "").split("_");
    if (parts.length < 2 || parts[0] !== styleCode) continue;
    const [, colorCode, seq = ""] = parts;
    if (!knownCodes.has(colorCode)) continue;
    const existing = best.get(colorCode);
    if (!existing || seq === "01") {
      best.set(colorCode, { seq, url });
    }
  }
  const result = new Map<string, string>();
  for (const [code, entry] of best) result.set(code, entry.url);
  return result;
}

export interface CaptureProductResult {
  pdtid: number;
  styleCode: string;
  ok: boolean;
  variantCount: number;
  warnings: string[];
  error?: string;
}

export async function captureProduct(pdtid: number): Promise<CaptureProductResult> {
  const warnings: string[] = [];

  const detail = await withRetry(() => fetchProductDetail(pdtid));
  await sleep(CALL_PACING_MS);
  const sheet = await withRetry(() => fetchSkuSheet(pdtid));

  const styleCode = detail.no ?? "";
  const name = detail.note ?? "";

  if (!styleCode) {
    return { pdtid, styleCode, ok: false, variantCount: 0, warnings, error: "missing styleCode from product detail" };
  }

  const parsed = parseSkuSheet(sheet, styleCode);
  const entries = parsed.filter((e) => {
    if (!e.colorCode) {
      warnings.push(`skipped a stock row with unresolved colorCode ("${e.colorName}")`);
      return false;
    }
    return true;
  });

  if (entries.length === 0) {
    warnings.push("zero variants produced — flagged, no Product/Variant rows written");
    return { pdtid, styleCode, ok: false, variantCount: 0, warnings, error: "no stock rows parsed from sku-sheet" };
  }

  const knownCodes = new Set(entries.map((e) => e.colorCode));
  const colorImages = buildColorImageMap(detail.allpic, styleCode, knownCodes);

  // 1. Color map self-maintains: upsert every colorCode -> colorName seen.
  const colorNameByCode = new Map<string, string>();
  for (const e of entries) {
    if (!colorNameByCode.has(e.colorCode)) colorNameByCode.set(e.colorCode, e.colorName);
  }
  for (const [colorCode, colorName] of colorNameByCode) {
    await prisma.color.upsert({
      where: { colorCode },
      update: { colorName },
      create: { colorCode, colorName },
    });
  }

  // 2. Product, keyed on pdtid.
  const productFields = {
    styleCode,
    name,
    mainpic: detail.mainpic ?? "",
    kelmeCatalogPrice: typeof detail.price === "number" ? detail.price : null,
    kelmeFobCost: extractFobCost(detail.priceList),
    categoryIds: categoryIdsOf(detail),
    syncedAt: new Date(),
  };
  const product = await prisma.product.upsert({
    where: { pdtid },
    update: productFields,
    create: { pdtid, ...productFields },
  });

  // 3. Variants, keyed on [productId, colorCode, shopifySize]. qty 0 is
  // stored explicitly — it's meaningful stock information, not "no data".
  let variantCount = 0;
  for (const entry of entries) {
    const shopifySize = resolveShopifySize(entry.kelmeSize);
    if (shopifySize === null) {
      warnings.push(`unmapped kids size "${entry.kelmeSize}" (color ${entry.colorCode}) — skipped, not written`);
      continue;
    }
    const sku = buildSku(styleCode, entry.colorCode, shopifySize);
    const imageUrl = colorImages.get(entry.colorCode) ?? null;

    await prisma.variant.upsert({
      where: {
        productId_colorCode_shopifySize: {
          productId: product.id,
          colorCode: entry.colorCode,
          shopifySize,
        },
      },
      update: {
        colorName: entry.colorName,
        kelmeSize: entry.kelmeSize,
        qty: entry.qty,
        imageUrl,
        sku,
      },
      create: {
        productId: product.id,
        colorCode: entry.colorCode,
        colorName: entry.colorName,
        kelmeSize: entry.kelmeSize,
        shopifySize,
        qty: entry.qty,
        imageUrl,
        sku,
      },
    });
    variantCount++;
  }

  return { pdtid, styleCode, ok: true, variantCount, warnings };
}

export interface CaptureAllReport {
  total: number;
  captured: number;
  failed: { pdtid: number; styleCode: string; error: string }[];
  zeroVariant: number[];
  colorsInMap: number;
  totalVariants: number;
  stoppedEarly: boolean;
  stopReason?: string;
}

export async function captureAllFavorites(): Promise<CaptureAllReport> {
  const report: CaptureAllReport = {
    total: 0,
    captured: 0,
    failed: [],
    zeroVariant: [],
    colorsInMap: 0,
    totalVariants: 0,
    stoppedEarly: false,
  };

  const favorites: { id: number; no: string }[] = [];
  let start = 0;
  let total = Infinity;
  while (start < total) {
    const page = await withRetry(() => fetchFavoritesPage(start, FAVORITES_PAGE_SIZE));
    total = page.total;
    report.total = total;
    if (page.products.length === 0) break;
    favorites.push(...page.products.map((p) => ({ id: p.id, no: p.no })));
    start += page.products.length;
    await sleep(CALL_PACING_MS);
  }

  for (let i = 0; i < favorites.length; i++) {
    const { id, no } = favorites[i];
    console.log(`[kelme-capture] (${i + 1}/${favorites.length}) capturing pdtid ${id} (${no})...`);

    try {
      const result = await captureProduct(id);
      if (result.ok) {
        report.captured++;
        report.totalVariants += result.variantCount;
      } else {
        if (result.variantCount === 0) report.zeroVariant.push(id);
        report.failed.push({ pdtid: id, styleCode: result.styleCode, error: result.error ?? "unknown error" });
      }
      for (const warning of result.warnings) {
        console.warn(`[kelme-capture]   pdtid ${id}: ${warning}`);
      }
    } catch (err) {
      if (isDeadTokenError(err)) {
        report.stoppedEarly = true;
        report.stopReason = "Kelme session expired (code 000005) — stopped, existing data left untouched";
        console.error(`[kelme-capture] ${report.stopReason}`);
        break;
      }
      report.failed.push({ pdtid: id, styleCode: no, error: err instanceof Error ? err.message : String(err) });
    }

    await sleep(CALL_PACING_MS);
  }

  report.colorsInMap = await prisma.color.count();

  console.log(
    `[kelme-capture] summary: captured=${report.captured}/${report.total} failed=${report.failed.length} ` +
      `zeroVariant=${report.zeroVariant.length} colorsInMap=${report.colorsInMap} totalVariants=${report.totalVariants}` +
      (report.stoppedEarly ? ` STOPPED EARLY: ${report.stopReason}` : ""),
  );

  return report;
}
