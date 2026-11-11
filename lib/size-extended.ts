/**
 * Pass 2 (4XL-7XL on LIVE products) — read-only planning/report.
 * Works before the new Size rows are seeded: it classifies Kelme's raw sheet
 * labels with classifySize + ADULT_EXTENDED directly, not via the Size table.
 *
 * Kelme exposes ONE price per product (catalog + FOB), not per size, so a
 * "4XL vs S-3XL price" comparison cannot come from Kelme. What matters for the
 * write is the Shopify side: new variants take the product's current uniform
 * price, and the price guard stops on mixed or zero prices. The report lists
 * both, plus Kelme's catalog/FOB for context.
 */
import { prisma } from "@/lib/prisma";
import { fetchSkuSheet } from "@/lib/kelme";
import { parseSkuSheet } from "@/lib/stock";
import { isBallProduct } from "@/lib/kelme-capture";
import { buildSku } from "@/lib/sku";
import { fetchSnapshot, productGidsForVariants } from "@/lib/size-relabel";
import { ADULT_EXTENDED, classifySize } from "@/lib/size-config";

/** Variant cap per product that the user wants respected (no splitting of live products). */
export const VARIANT_CAP = 100;

export interface ExtendedRow {
  styleCode: string;
  title: string;
  status: string;
  currentVariants: number;
  colorsLive: number;
  newVariants: { colorCode: string; size: string; qty: number; sku: string }[];
  colorsWithoutLiveVariant: string[]; // Kelme offers an extended size in a color the product does not have on Shopify
  prices: string[]; // distinct Shopify variant prices (1 = uniform)
  kelmeCatalogPrice: number | null;
  kelmeFobCost: number | null;
  afterCount: number;
  overCap: boolean;
  problems: string[];
}

export async function planExtended(styleCode: string): Promise<ExtendedRow | null> {
  const product = await prisma.product.findFirst({ where: { styleCode }, include: { variants: true } });
  if (!product) return null;
  const sheet = await fetchSkuSheet(product.pdtid);
  const { entries } = parseSkuSheet(sheet, styleCode);
  if (isBallProduct(product.name)) return null;
  const wanted = entries.filter((e) => e.colorCode && (() => {
    const c = classifySize(e.kelmeSize, false);
    return c.status === "ok" && ADULT_EXTENDED.includes(c.shopifySize);
  })());
  if (wanted.length === 0) return null;

  const row: ExtendedRow = {
    styleCode, title: "", status: "", currentVariants: 0, colorsLive: 0, newVariants: [], colorsWithoutLiveVariant: [],
    prices: [], kelmeCatalogPrice: product.kelmeCatalogPrice ?? null, kelmeFobCost: product.kelmeFobCost ?? null,
    afterCount: 0, overCap: false, problems: [],
  };
  const linkedGids = [...new Set(product.variants.map((v) => v.shopifyVariantId).filter((x): x is string => !!x))];
  const productGids = [...new Set((await productGidsForVariants(linkedGids.slice(0, 50))).values())];
  if (productGids.length !== 1) {
    row.problems.push(`DB variants map to ${productGids.length} Shopify products (expected exactly 1)`);
    return row;
  }
  const snap = await fetchSnapshot(productGids[0]);
  row.title = snap.title;
  row.status = snap.status;
  row.currentVariants = snap.variants.length;
  row.prices = [...new Set(snap.variants.map((v) => Number(v.price).toFixed(2)))].sort();
  const haveSku = new Set(snap.variants.map((v) => v.sku));
  const liveColors = new Set(snap.variants.map((v) => v.sku.split("-")[1] ?? ""));
  row.colorsLive = liveColors.size;
  const seen = new Set<string>();
  for (const e of wanted) {
    const c = classifySize(e.kelmeSize, false);
    if (c.status !== "ok") continue;
    const sku = buildSku(styleCode, e.colorCode, c.shopifySize);
    if (seen.has(sku) || haveSku.has(sku)) continue;
    seen.add(sku);
    if (!liveColors.has(e.colorCode)) {
      if (!row.colorsWithoutLiveVariant.includes(e.colorCode)) row.colorsWithoutLiveVariant.push(e.colorCode);
      continue;
    }
    row.newVariants.push({ colorCode: e.colorCode, size: c.shopifySize, qty: e.qty, sku });
  }
  row.afterCount = row.currentVariants + row.newVariants.length;
  row.overCap = row.afterCount > VARIANT_CAP;
  if (row.prices.length > 1) row.problems.push(`mixed prices ${row.prices.join(", ")} — price guard will stop`);
  if (row.prices.length === 1 && Number(row.prices[0]) <= 0) row.problems.push("zero price — price guard will stop");
  if (row.colorsWithoutLiveVariant.length > 0) row.problems.push(`extended sizes exist in color(s) not on the live product: ${row.colorsWithoutLiveVariant.join(",")} (skipped; not added)`);
  return row;
}

/** Styles that are live (any DB variant linked to Shopify) and adult apparel. */
export async function liveStyleCodes(): Promise<string[]> {
  const rows = await prisma.product.findMany({
    where: { variants: { some: { shopifyVariantId: { not: null } } } },
    select: { styleCode: true },
    orderBy: { styleCode: "asc" },
  });
  return rows.map((r) => r.styleCode);
}

export function reportMarkdown(rows: ExtendedRow[], scanned: number): string {
  const total = rows.reduce((a, r) => a + r.newVariants.length, 0);
  const over = rows.filter((r) => r.overCap);
  const L: string[] = [];
  L.push("# Pass 2 — 4XL–7XL impact report (read-only)", "");
  L.push(`Live styles scanned: ${scanned}. Affected (Kelme offers 4XL–7XL): **${rows.length}**. New variants: **${total}**. Over ${VARIANT_CAP} variants after: **${over.length}**.`, "");
  L.push("Kelme prices are per product, not per size — no 4XL-vs-S price difference can exist on Kelme's side. New variants take the product's current uniform Shopify price; mixed/zero prices stop the run.", "");
  L.push("| style | title | status | now | +new | after | over cap | Shopify price(s) | Kelme catalog | Kelme FOB | notes |", "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    L.push(`| ${r.styleCode} | ${r.title.slice(0, 40)} | ${r.status} | ${r.currentVariants} | ${r.newVariants.length} | ${r.afterCount} | ${r.overCap ? "**YES**" : ""} | ${r.prices.join(" / ")} | ${r.kelmeCatalogPrice ?? ""} | ${r.kelmeFobCost ?? ""} | ${r.problems.join("; ")} |`);
  }
  L.push("", "## Over the variant cap", ...(over.length ? over.map((r) => `- ${r.styleCode} ${r.title}: ${r.currentVariants} + ${r.newVariants.length} = ${r.afterCount}`) : ["none"]));
  const prob = rows.filter((r) => r.problems.length);
  L.push("", "## Problems", ...(prob.length ? prob.map((r) => `- ${r.styleCode}: ${r.problems.join("; ")}`) : ["none"]));
  return L.join("\n") + "\n";
}
