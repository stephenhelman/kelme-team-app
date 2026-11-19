/**
 * Removal of variants a person created by hand in Shopify admin for a size Kelme does not stock (the 51 manual
 * "XS" variants on 12 adult products, 2026-11-18). Dry-run lists every variant and WHY it is (or isn't) removable;
 * execute deletes only the ones that pass EVERY check:
 *
 *   - Size option value is the target size (default "XS") and the variant has NO SKU (variant and inventory item) —
 *     our pipeline always stamps SKUs, so a blank SKU means hand-made
 *   - no DB Variant links to it
 *   - Kelme's live sheet for that style does not declare that (color, size) — if Kelme starts stocking it, keep it
 *   - on_hand is 0 (or no level) at the location
 *   - no Shopify order (since the variant was created) contains it
 *   - the product's title carries exactly one DB style code
 */
import { appendFile } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { shopifyGraphQL } from "@/lib/shopify";
import { fetchSkuSheet } from "@/lib/kelme";
import { parseSkuSheet } from "@/lib/stock";
import { buildDeclaredVariants, isBallProduct } from "@/lib/kelme-capture";
import { matchingStyleCodes } from "@/lib/style-match";
import { INVENTORY_LOCATION_ID } from "@/lib/shopify-inventory-push";
import { bulkDeleteVariants } from "@/lib/size-bulk";
import { fetchSnapshot } from "@/lib/size-relabel";

const LOG_PATH = path.join(process.cwd(), "manual-variant-removal-log.jsonl");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ShopifyVariantLite {
  id: string;
  productGid: string;
  productTitle: string;
  sku: string; // variant sku ("" if null)
  itemSku: string; // inventory item sku ("" if null)
  color: string | null;
  size: string | null;
  onHand: number | null; // null = no level at the location
  price: string;
  createdAt: string;
}

export interface RemovalContext {
  targetSize: string;
  styleOf: (title: string) => string | null; // the single DB style code in the title, else null
  colorCodeOf: (colorOptionValue: string) => string | null;
  dbLinkedVariantIds: Set<string>;
  kelmeDeclares: (styleCode: string, colorCode: string, size: string) => boolean;
  orderedVariantIds: Set<string>;
}

export interface Verdict {
  variant: ShopifyVariantLite;
  styleCode: string | null;
  colorCode: string | null;
  remove: boolean;
  reasons: string[]; // why NOT removable (empty when remove)
}

/** Pure. Only variants of the target size are judged; everything else is ignored. */
export function judgeManualVariants(variants: ShopifyVariantLite[], ctx: RemovalContext): Verdict[] {
  const out: Verdict[] = [];
  for (const v of variants) {
    if (v.size !== ctx.targetSize) continue;
    const styleCode = ctx.styleOf(v.productTitle);
    const colorCode = v.color ? ctx.colorCodeOf(v.color) : null;
    const reasons: string[] = [];
    if (v.sku || v.itemSku) reasons.push(`has a SKU (${v.sku || v.itemSku}) — not hand-made`);
    if (ctx.dbLinkedVariantIds.has(v.id)) reasons.push("a DB variant is linked to it");
    if (!styleCode) reasons.push("product title does not carry exactly one known style code");
    if (!colorCode) reasons.push("color code not parseable");
    if (styleCode && colorCode && ctx.kelmeDeclares(styleCode, colorCode, ctx.targetSize)) reasons.push("Kelme now declares this color/size");
    if (v.onHand !== null && v.onHand !== 0) reasons.push(`on_hand is ${v.onHand}`);
    if (ctx.orderedVariantIds.has(v.id)) reasons.push("an order references it");
    out.push({ variant: v, styleCode, colorCode, remove: reasons.length === 0, reasons });
  }
  return out;
}

const PRODUCTS_QUERY = `
  query manualVariants($cursor: String, $loc: ID!) {
    products(first: 25, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id title
        variants(first: 250) { edges { node {
          id sku createdAt price
          selectedOptions { name value }
          inventoryItem { sku inventoryLevel(locationId: $loc) { quantities(names: ["on_hand"]) { quantity } } }
        } } }
      } }
    }
  }
`;

export async function fetchTargetSizeVariants(targetSize: string): Promise<ShopifyVariantLite[]> {
  const out: ShopifyVariantLite[] = [];
  let cursor: string | null = null;
  for (;;) {
    const res: { data?: any; errors?: unknown[] } = await shopifyGraphQL<any>(PRODUCTS_QUERY, { cursor, loc: INVENTORY_LOCATION_ID });
    if (res.errors?.length) throw new Error(`products query error: ${JSON.stringify(res.errors)}`);
    for (const { node: p } of res.data.products.edges) {
      for (const { node: v } of p.variants.edges) {
        const size = v.selectedOptions.find((o: any) => o.name === "Size")?.value ?? null;
        if (size !== targetSize) continue;
        out.push({
          id: v.id,
          productGid: p.id,
          productTitle: p.title,
          sku: v.sku ?? "",
          itemSku: v.inventoryItem?.sku ?? "",
          color: v.selectedOptions.find((o: any) => o.name === "Color")?.value ?? null,
          size,
          onHand: v.inventoryItem?.inventoryLevel?.quantities?.[0]?.quantity ?? null,
          price: v.price,
          createdAt: v.createdAt,
        });
      }
    }
    if (!res.data.products.pageInfo.hasNextPage) break;
    cursor = res.data.products.pageInfo.endCursor;
    await sleep(300);
  }
  return out;
}

/** Every variant id on any order created on/after `sinceIso` (draft orders are not orders yet and can't hold stock). */
export async function fetchOrderedVariantIds(sinceIso: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const res: { data?: any; errors?: unknown[] } = await shopifyGraphQL<any>(
      `query($cursor:String,$q:String){ orders(first:100, after:$cursor, query:$q){ pageInfo{hasNextPage endCursor} edges{node{ lineItems(first:100){ edges{node{ variant{ id } }} } }}}}`,
      { cursor, q: `created_at:>=${sinceIso}` },
    );
    if (res.errors?.length) throw new Error(`orders query error: ${JSON.stringify(res.errors)}`);
    for (const { node: o } of res.data.orders.edges) for (const { node: li } of o.lineItems.edges) if (li.variant?.id) ids.add(li.variant.id);
    if (!res.data.orders.pageInfo.hasNextPage) break;
    cursor = res.data.orders.pageInfo.endCursor;
    await sleep(300);
  }
  return ids;
}

export interface ManualRemovalPlan {
  targetSize: string;
  verdicts: Verdict[];
  ordersChecked: boolean;
}

export async function planManualRemoval(targetSize: string): Promise<ManualRemovalPlan> {
  const all = await fetchTargetSizeVariants(targetSize);
  const blankSku = all.filter((v) => !v.sku && !v.itemSku);
  const dbProducts = await prisma.product.findMany({ select: { id: true, pdtid: true, styleCode: true, name: true } });
  const styleCodes = [...new Set(dbProducts.map((p) => p.styleCode))];
  const styleOf = (title: string) => {
    const m = matchingStyleCodes(title, styleCodes);
    return m.length === 1 ? m[0] : null;
  };
  const linked = new Set(
    (await prisma.variant.findMany({ where: { shopifyVariantId: { not: null } }, select: { shopifyVariantId: true } })).map((v) => v.shopifyVariantId!),
  );

  // Kelme's live declaration for every style that has a candidate (one sheet per style).
  const styles = [...new Set(blankSku.map((v) => styleOf(v.productTitle)).filter((s): s is string => !!s))];
  const allowed = new Set((await prisma.size.findMany({ select: { shopifySize: true } })).map((s) => s.shopifySize));
  const declared = new Set<string>();
  for (const style of styles) {
    const p = dbProducts.find((x) => x.styleCode === style)!;
    const { entries } = parseSkuSheet(await fetchSkuSheet(p.pdtid), style);
    for (const d of buildDeclaredVariants(entries, isBallProduct(p.name), allowed)) declared.add(`${style}::${d.colorCode}::${d.shopifySize}`);
    await sleep(400);
  }

  const since = blankSku.length ? new Date(Math.min(...blankSku.map((v) => Date.parse(v.createdAt))) - 86_400_000).toISOString() : new Date().toISOString();
  const ordered = blankSku.length ? await fetchOrderedVariantIds(since) : new Set<string>();

  const { parseColorCode } = await import("@/lib/shopify-reconcile");
  const verdicts = judgeManualVariants(all, {
    targetSize,
    styleOf,
    colorCodeOf: (c) => parseColorCode(c),
    dbLinkedVariantIds: linked,
    kelmeDeclares: (s, c, z) => declared.has(`${s}::${c}::${z}`),
    orderedVariantIds: ordered,
  });
  return { targetSize, verdicts, ordersChecked: true };
}

export interface ManualRemovalResult {
  deleted: number;
  optionValuesDropped: string[];
  problems: string[];
}

export async function executeManualRemoval(plan: ManualRemovalPlan): Promise<ManualRemovalResult> {
  const result: ManualRemovalResult = { deleted: 0, optionValuesDropped: [], problems: [] };
  const byProduct = new Map<string, Verdict[]>();
  for (const v of plan.verdicts.filter((x) => x.remove)) {
    if (!byProduct.has(v.variant.productGid)) byProduct.set(v.variant.productGid, []);
    byProduct.get(v.variant.productGid)!.push(v);
  }
  for (const [productGid, vs] of byProduct) {
    // Audit log first (enough to recreate by hand), then delete.
    await appendFile(
      LOG_PATH,
      vs.map((v) => JSON.stringify({ at: new Date().toISOString(), productGid, id: v.variant.id, color: v.variant.color, size: v.variant.size, price: v.variant.price, createdAt: v.variant.createdAt })).join("\n") + "\n",
    );
    await bulkDeleteVariants(productGid, vs.map((v) => v.variant.id));
    result.deleted += vs.length;
    // Drop the now-unused size option value (only if no remaining variant uses it).
    const snap = await fetchSnapshot(productGid);
    const used = new Set(snap.variants.map((v) => v.size));
    const dead = (snap.sizeOption?.values ?? []).filter((v) => v.name === plan.targetSize && !used.has(v.name));
    if (dead.length && snap.sizeOption) {
      const res = await shopifyGraphQL<{ productOptionUpdate: { userErrors: { message: string }[] } }>(
        `mutation($productId:ID!,$option:OptionUpdateInput!,$del:[ID!]){ productOptionUpdate(productId:$productId, option:$option, optionValuesToDelete:$del){ userErrors{ message } } }`,
        { productId: productGid, option: { id: snap.sizeOption.id }, del: dead.map((d) => d.id) },
      );
      const ue = res.data?.productOptionUpdate.userErrors ?? [];
      if (res.errors?.length || ue.length) result.problems.push(`${snap.title}: could not drop option value ${plan.targetSize}: ${JSON.stringify(res.errors ?? ue)}`);
      else result.optionValuesDropped.push(snap.title);
    }
    await sleep(500);
  }
  return result;
}
