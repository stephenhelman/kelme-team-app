/**
 * The permanent Kelme capture module. Per-product capture is the core unit —
 * `captureProduct(pdtid)` pulls one product's detail + stock and upserts
 * Color/Product/Variant; `captureAllFavorites()` is just a paced loop over
 * it. Server-only (imports lib/kelme.ts, which reads the token from the DB).
 *
 * NOT in this module: matching Variants to Shopify variantId/inventoryItemId
 * and pushing inventory. That's a separate, later step.
 */
import { prisma } from "@/lib/prisma";
import { buildSku, ONE_SIZE } from "@/lib/sku";
import { parseSkuSheet, type SkuSheetEntry } from "@/lib/stock";
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

// Kids gear resolves to the EU size for the SKU/Shopify side; adults and
// one-size items keep their KELME value as-is. Never the raw cm, never US.
const KIDS_EU_SIZE_MAP: Record<string, string> = {
  "100cm": "2",
  "110cm": "4",
  "120cm": "6",
  "130cm": "8",
  "140cm": "10",
  "150cm": "12",
  "160cm": "14",
  "170cm": "16",
};

// A bare numeric size label ("4", "110") is ambiguous on its own — it's
// either a kids height in cm or a ball size, and the sku-sheet grid gives no
// unit. The product name disambiguates, but a plain /ball/i test is a false
// positive for ball-branded apparel/accessories: "Short Sleeve Football Set
// (Kids)", "Football Shorts", "Football Socks", "Basketball Bag", "Football
// Tactics Board", "Pe Football Net" all match "ball" via "football"/
// "basketball" without being an actual ball — and wrongly skipping the
// kids-cm/One-Size resolution for those silently drops every one of their
// variants (the raw Kelme label never matches the Size allow-list). Real
// ball listings in the catalog are plain — "Football (Hand Stitching)",
// "Vortex 18.2 Football (Laminated)", "Futsal Ball (Laminated)" — none of
// them carry an apparel/accessory qualifier, so excluding those qualifiers
// cleanly separates the two (confirmed against every "ball"-matching name in
// the live catalog).
const NON_BALL_QUALIFIERS = /\b(set|shorts|shirt|socks|bag|net|board)\b/i;
function isBallProduct(name: string): boolean {
  return /ball/i.test(name) && !NON_BALL_QUALIFIERS.test(name);
}

export interface ResolvedSize {
  kelmeSize: string;
  shopifySize: string;
}

// Returns null when the size can't be resolved — the caller must flag and
// skip that variant rather than fall back to a raw/ambiguous value, which
// would leak an unresolved size into shopifySize/SKU.
function resolveSize(rawLabel: string, isBall: boolean): ResolvedSize | null {
  if (isBall) {
    // Ball sizes are the KELME value itself — no cm, no EU mapping.
    return { kelmeSize: rawLabel, shopifySize: rawLabel };
  }
  if (/^\d+$/.test(rawLabel)) {
    // A bare number on a non-ball product is a kids height in cm.
    const kelmeSize = `${rawLabel}cm`;
    const shopifySize = KIDS_EU_SIZE_MAP[kelmeSize];
    return shopifySize ? { kelmeSize, shopifySize } : null;
  }
  // Kelme's one-size label is Chinese (均码) — normalize it so it never
  // leaks into a SKU or a Shopify-facing size string.
  if (rawLabel === "均码" || rawLabel.trim() === "") {
    return { kelmeSize: rawLabel, shopifySize: ONE_SIZE };
  }
  // Adult letter sizes, etc. — KELME value passes through.
  return { kelmeSize: rawLabel, shopifySize: rawLabel };
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
  blankDropped: number;
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
    return { pdtid, styleCode, ok: false, variantCount: 0, blankDropped: 0, warnings, error: "missing styleCode from product detail" };
  }

  const { entries: parsed, blankCount } = parseSkuSheet(sheet, styleCode);
  const entries = parsed.filter((e) => {
    if (!e.colorCode) {
      warnings.push(`skipped a stock row with unresolved colorCode ("${e.colorName}")`);
      return false;
    }
    return true;
  });

  if (entries.length === 0) {
    warnings.push("zero variants produced — flagged, no Product/Variant rows written");
    return { pdtid, styleCode, ok: false, variantCount: 0, blankDropped: blankCount, warnings, error: "no stock rows parsed from sku-sheet" };
  }

  const allowedSizes = new Set((await prisma.size.findMany({ select: { shopifySize: true } })).map((s) => s.shopifySize));

  const knownCodes = new Set(entries.map((e) => e.colorCode));
  const colorImages = buildColorImageMap(detail.allpic, styleCode, knownCodes);
  const isBall = isBallProduct(name);

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
    const resolved = resolveSize(entry.kelmeSize, isBall);
    if (resolved === null) {
      warnings.push(`unmapped size "${entry.kelmeSize}" (color ${entry.colorCode}) — skipped, not written`);
      continue;
    }
    const { kelmeSize, shopifySize } = resolved;
    if (!allowedSizes.has(shopifySize)) {
      warnings.push(`size "${shopifySize}" (color ${entry.colorCode}) not in Size allow-list — dropped, not written`);
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
        kelmeSize,
        qty: entry.qty,
        imageUrl,
        sku,
      },
      create: {
        productId: product.id,
        colorCode: entry.colorCode,
        colorName: entry.colorName,
        kelmeSize,
        shopifySize,
        qty: entry.qty,
        imageUrl,
        sku,
      },
    });
    variantCount++;
  }

  return { pdtid, styleCode, ok: true, variantCount, blankDropped: blankCount, warnings };
}

export interface ProductDeclarationResult {
  pdtid: number;
  styleCode: string;
  name: string;
  ok: boolean;
  colorsWritten: { colorCode: string; colorName: string }[];
  colorsIgnored: { colorCode: string; colorName: string; reason: string }[];
  sizesWritten: string[];
  sizesIgnored: { kelmeSize: string; reason: string }[];
  error?: string;
}

// Step 2 of the Shopify-mirror sprint — fresh Kelme pull -> authoritative
// Product.colors/Product.sizes. Deliberately does NOT touch Variant rows;
// rebuilding variants from this declaration is Step 3, kept separate so
// each destructive stage can be dry-run/approved on its own.
export async function pullProductDeclaration(pdtid: number, styleCodeHint?: string): Promise<ProductDeclarationResult> {
  const detail = await withRetry(() => fetchProductDetail(pdtid));
  await sleep(CALL_PACING_MS);
  const sheet = await withRetry(() => fetchSkuSheet(pdtid));

  const styleCode = detail.no || styleCodeHint || "";
  const name = detail.note ?? "";

  if (!styleCode) {
    return { pdtid, styleCode, name, ok: false, colorsWritten: [], colorsIgnored: [], sizesWritten: [], sizesIgnored: [], error: "missing styleCode from product detail" };
  }

  const { entries } = parseSkuSheet(sheet, styleCode);
  const isBall = isBallProduct(name);
  const allowedSizes = new Set((await prisma.size.findMany({ select: { shopifySize: true } })).map((s) => s.shopifySize));

  // Colors: every colorCode present in `entries` already survived the
  // blank-inventory filter in parseSkuSheet (a blank cell never becomes an
  // entry) — so any colorCode here holds real stock in at least one size.
  // "Ignored" colors are named by Kelme (detail.colors, a name-only hint)
  // but never produced a single stocked entry.
  const colorsWritten = new Map<string, string>();
  for (const e of entries) {
    if (e.colorCode) colorsWritten.set(e.colorCode, e.colorName);
  }
  const namedColorNames = new Set((detail.colors ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const stockedColorNames = new Set([...colorsWritten.values()]);
  const colorsIgnored: { colorCode: string; colorName: string; reason: string }[] = [];
  for (const namedColor of namedColorNames) {
    if (!stockedColorNames.has(namedColor)) {
      colorsIgnored.push({ colorCode: "", colorName: namedColor, reason: "named by Kelme but zero stocked entries (blank inventory across every size)" });
    }
  }
  for (const e of entries) {
    if (!e.colorCode) {
      colorsIgnored.push({ colorCode: "", colorName: e.colorName, reason: "unresolved colorCode (not in colorContrast map)" });
    }
  }

  const sizesWritten = new Set<string>();
  const sizesIgnored: { kelmeSize: string; reason: string }[] = [];
  for (const e of entries) {
    const resolved = resolveSize(e.kelmeSize, isBall);
    if (resolved === null) {
      sizesIgnored.push({ kelmeSize: e.kelmeSize, reason: "unresolvable size label" });
      continue;
    }
    if (!allowedSizes.has(resolved.shopifySize)) {
      sizesIgnored.push({ kelmeSize: e.kelmeSize, reason: `resolved size "${resolved.shopifySize}" not in Size allow-list` });
      continue;
    }
    sizesWritten.add(resolved.shopifySize);
  }

  await prisma.product.update({
    where: { pdtid },
    data: {
      colors: [...colorsWritten.keys()].sort(),
      sizes: [...sizesWritten].sort(),
      syncedAt: new Date(),
    },
  });

  return {
    pdtid,
    styleCode,
    name,
    ok: true,
    colorsWritten: [...colorsWritten].map(([colorCode, colorName]) => ({ colorCode, colorName })),
    colorsIgnored,
    sizesWritten: [...sizesWritten].sort(),
    sizesIgnored,
  };
}

export interface PullDeclarationsReport {
  total: number;
  ok: number;
  failed: { pdtid: number; styleCode: string; error: string }[];
  stoppedEarly: boolean;
  stopReason?: string;
  products: ProductDeclarationResult[];
}

// Batch runner for Step 2 — every onShopify:true product, paced like
// captureAllFavorites. Read-only against Variant/onShopify; only
// Product.colors/sizes/syncedAt are written.
export async function pullAllDeclarations(): Promise<PullDeclarationsReport> {
  const report: PullDeclarationsReport = { total: 0, ok: 0, failed: [], stoppedEarly: false, products: [] };

  const targets = await prisma.product.findMany({
    where: { onShopify: true },
    orderBy: { id: "asc" },
    select: { pdtid: true, styleCode: true },
  });
  report.total = targets.length;

  for (let i = 0; i < targets.length; i++) {
    const { pdtid, styleCode } = targets[i];
    console.log(`[kelme-capture] declaration (${i + 1}/${targets.length}) pdtid ${pdtid} (${styleCode})...`);
    try {
      const result = await pullProductDeclaration(pdtid, styleCode);
      report.products.push(result);
      if (result.ok) {
        report.ok++;
      } else {
        report.failed.push({ pdtid, styleCode, error: result.error ?? "unknown error" });
      }
    } catch (err) {
      if (isDeadTokenError(err)) {
        report.stoppedEarly = true;
        report.stopReason = "Kelme session expired (code 000005) — stopped, existing data left untouched";
        console.error(`[kelme-capture] ${report.stopReason}`);
        break;
      }
      report.failed.push({ pdtid, styleCode, error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(CALL_PACING_MS);
  }

  console.log(
    `[kelme-capture] declarations summary: ok=${report.ok}/${report.total} failed=${report.failed.length}` +
      (report.stoppedEarly ? ` STOPPED EARLY: ${report.stopReason}` : ""),
  );

  return report;
}

export interface DeclaredVariant {
  colorCode: string;
  colorName: string;
  kelmeSize: string;
  shopifySize: string;
  qty: number;
}

// Step 3's variant grid — identical resolution to captureProduct's variant
// loop (blank cells never reach `entries`, so they never reach here either),
// just returned instead of upserted. Deduped by (colorCode, shopifySize)
// with last-entry-wins, matching the upsert's unique constraint.
export function buildDeclaredVariants(entries: SkuSheetEntry[], isBall: boolean, allowedSizes: Set<string>): DeclaredVariant[] {
  const byKey = new Map<string, DeclaredVariant>();
  for (const entry of entries) {
    if (!entry.colorCode) continue;
    const resolved = resolveSize(entry.kelmeSize, isBall);
    if (resolved === null) continue;
    const { kelmeSize, shopifySize } = resolved;
    if (!allowedSizes.has(shopifySize)) continue;
    byKey.set(`${entry.colorCode}::${shopifySize}`, {
      colorCode: entry.colorCode,
      colorName: entry.colorName,
      kelmeSize,
      shopifySize,
      qty: entry.qty,
    });
  }
  return [...byKey.values()];
}

export interface RebuildVariantsResult {
  pdtid: number;
  styleCode: string;
  ok: boolean;
  deletedCount: number;
  createdCount: number;
  error?: string;
}

// Step 3 — delete the existing (muddied) variants and rebuild cleanly from
// a fresh Kelme pull, per onShopify:true product. Delete-then-create (not
// upsert) so stale combos from the old muddied data don't survive.
export async function rebuildVariantsForProduct(pdtid: number, styleCode: string): Promise<RebuildVariantsResult> {
  const detail = await withRetry(() => fetchProductDetail(pdtid));
  await sleep(CALL_PACING_MS);
  const sheet = await withRetry(() => fetchSkuSheet(pdtid));

  const resolvedStyleCode = detail.no || styleCode;
  const name = detail.note ?? "";

  const { entries } = parseSkuSheet(sheet, resolvedStyleCode);
  const isBall = isBallProduct(name);
  const allowedSizes = new Set((await prisma.size.findMany({ select: { shopifySize: true } })).map((s) => s.shopifySize));
  const declared = buildDeclaredVariants(entries, isBall, allowedSizes);

  const knownCodes = new Set(declared.map((d) => d.colorCode));
  const colorImages = buildColorImageMap(detail.allpic, resolvedStyleCode, knownCodes);

  const product = await prisma.product.findUniqueOrThrow({ where: { pdtid }, select: { id: true } });

  const [deleted] = await prisma.$transaction([
    prisma.variant.deleteMany({ where: { productId: product.id } }),
    prisma.variant.createMany({
      data: declared.map((d) => ({
        productId: product.id,
        colorCode: d.colorCode,
        colorName: d.colorName,
        kelmeSize: d.kelmeSize,
        shopifySize: d.shopifySize,
        qty: d.qty,
        imageUrl: colorImages.get(d.colorCode) ?? null,
        sku: buildSku(resolvedStyleCode, d.colorCode, d.shopifySize),
      })),
    }),
  ]);

  return { pdtid, styleCode: resolvedStyleCode, ok: true, deletedCount: deleted.count, createdCount: declared.length };
}

export interface RebuildAllReport {
  onShopifyTotal: number;
  rebuilt: RebuildVariantsResult[];
  failed: { pdtid: number; styleCode: string; error: string }[];
  stoppedEarly: boolean;
  stopReason?: string;
  totalDeleted: number;
  totalCreated: number;
  offShopifyProductsCleared: number;
  offShopifyVariantsDeleted: number;
}

export async function rebuildAllVariants(): Promise<RebuildAllReport> {
  const report: RebuildAllReport = {
    onShopifyTotal: 0,
    rebuilt: [],
    failed: [],
    stoppedEarly: false,
    totalDeleted: 0,
    totalCreated: 0,
    offShopifyProductsCleared: 0,
    offShopifyVariantsDeleted: 0,
  };

  // Out-of-scope products first — delete-only, no Kelme calls needed.
  const offShopify = await prisma.product.findMany({ where: { onShopify: false }, select: { id: true } });
  const offShopifyDelete = await prisma.variant.deleteMany({ where: { productId: { in: offShopify.map((p) => p.id) } } });
  report.offShopifyProductsCleared = offShopify.length;
  report.offShopifyVariantsDeleted = offShopifyDelete.count;

  const targets = await prisma.product.findMany({
    where: { onShopify: true },
    orderBy: { id: "asc" },
    select: { pdtid: true, styleCode: true },
  });
  report.onShopifyTotal = targets.length;

  for (let i = 0; i < targets.length; i++) {
    const { pdtid, styleCode } = targets[i];
    console.log(`[kelme-capture] rebuild (${i + 1}/${targets.length}) pdtid ${pdtid} (${styleCode})...`);
    try {
      const result = await rebuildVariantsForProduct(pdtid, styleCode);
      report.rebuilt.push(result);
      report.totalDeleted += result.deletedCount;
      report.totalCreated += result.createdCount;
    } catch (err) {
      if (isDeadTokenError(err)) {
        report.stoppedEarly = true;
        report.stopReason = "Kelme session expired (code 000005) — stopped, existing data left untouched for remaining products";
        console.error(`[kelme-capture] ${report.stopReason}`);
        break;
      }
      report.failed.push({ pdtid, styleCode, error: err instanceof Error ? err.message : String(err) });
    }
    await sleep(CALL_PACING_MS);
  }

  console.log(
    `[kelme-capture] rebuild summary: rebuilt=${report.rebuilt.length}/${report.onShopifyTotal} failed=${report.failed.length} ` +
      `totalDeleted=${report.totalDeleted} totalCreated=${report.totalCreated} offShopifyDeleted=${report.offShopifyVariantsDeleted}` +
      (report.stoppedEarly ? ` STOPPED EARLY: ${report.stopReason}` : ""),
  );

  return report;
}

export interface CaptureAllReport {
  total: number;
  captured: number;
  failed: { pdtid: number; styleCode: string; error: string }[];
  zeroVariant: number[];
  colorsInMap: number;
  totalVariants: number;
  totalBlankDropped: number;
  blankDroppedByProduct: { pdtid: number; styleCode: string; blankDropped: number }[];
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
    totalBlankDropped: 0,
    blankDroppedByProduct: [],
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
      if (result.blankDropped > 0) {
        report.totalBlankDropped += result.blankDropped;
        report.blankDroppedByProduct.push({ pdtid: id, styleCode: result.styleCode, blankDropped: result.blankDropped });
      }
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
      `zeroVariant=${report.zeroVariant.length} colorsInMap=${report.colorsInMap} totalVariants=${report.totalVariants} ` +
      `totalBlankDropped=${report.totalBlankDropped}` +
      (report.stoppedEarly ? ` STOPPED EARLY: ${report.stopReason}` : ""),
  );

  return report;
}
