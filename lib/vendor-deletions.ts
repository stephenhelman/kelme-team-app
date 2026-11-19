/**
 * Vendor deletions: things the store owner/vendor deleted in Shopify admin on purpose. The DB must stop pointing
 * at them (null the ids, product off Shopify), and nothing automatic may recreate them.
 *
 * Pure detection + small DB appliers. Detection works on what relink already knows: the DB variants, which of them
 * relink matched this run, and the set of EVERY variant id that currently exists on Shopify (any product status).
 *
 *   deleted product  — no variant of the product matched, it had linked ids, and every linked id is gone.
 *                      -> DraftJob DELETED_BY_VENDOR (auto drafter never recreates it; only an explicit
 *                         `drafts create --styleCode X` can).
 *   removed variant  — the product is still on Shopify but a linked variant id is gone and the variant didn't
 *                      re-match (e.g. a color or size the vendor deleted). Ids are nulled automatically; recording a
 *                      VendorRemoval (so capture / add-sizes / rebuild never recreate it) is explicit
 *                      (`npm run vendor-deletions -- --execute`), because our own tooling also deletes variants.
 */
import { prisma } from "@/lib/prisma";

export const DELETED_BY_VENDOR = "DELETED_BY_VENDOR";
export const ANY_SIZE = "*";

export interface DbVariantLite {
  id: number;
  productId: number;
  styleCode: string;
  colorCode: string;
  shopifySize: string;
  sku: string;
  qty: number;
  shopifyVariantId: string | null;
}

export interface DeletedProduct {
  productId: number;
  styleCode: string;
  variants: number;
  qty: number;
}
export interface RemovedVariant {
  variantDbId: number;
  productId: number;
  styleCode: string;
  colorCode: string;
  shopifySize: string;
  sku: string;
  qty: number;
}
export interface VendorDeletions {
  deletedProducts: DeletedProduct[];
  removedVariants: RemovedVariant[];
  /** variants of DELETED products only -> relink nulls their ids (removed variants of live products keep theirs until recorded) */
  staleVariantDbIds: number[];
}

export function detectVendorDeletions(variants: DbVariantLite[], matchedDbIds: Set<number>, liveVariantIds: Set<string>): VendorDeletions {
  const byProduct = new Map<number, DbVariantLite[]>();
  for (const v of variants) {
    if (!byProduct.has(v.productId)) byProduct.set(v.productId, []);
    byProduct.get(v.productId)!.push(v);
  }
  const out: VendorDeletions = { deletedProducts: [], removedVariants: [], staleVariantDbIds: [] };
  for (const [productId, vs] of byProduct) {
    const anyMatched = vs.some((v) => matchedDbIds.has(v.id));
    const gone = vs.filter((v) => !matchedDbIds.has(v.id) && v.shopifyVariantId !== null && !liveVariantIds.has(v.shopifyVariantId));
    if (gone.length === 0) continue;
    const linked = vs.filter((v) => v.shopifyVariantId !== null);
    if (!anyMatched && gone.length === linked.length) {
      out.deletedProducts.push({ productId, styleCode: vs[0].styleCode, variants: vs.length, qty: vs.reduce((a, v) => a + v.qty, 0) });
      out.staleVariantDbIds.push(...gone.map((v) => v.id));
    } else if (anyMatched) {
      // Ids are deliberately left in place: they are the evidence `npm run vendor-deletions` needs to tell "the
      // vendor deleted this" from "never created". The push skips them (skipped_stale) until they are recorded.
      for (const v of gone) {
        out.removedVariants.push({ variantDbId: v.id, productId, styleCode: v.styleCode, colorCode: v.colorCode, shopifySize: v.shopifySize, sku: v.sku, qty: v.qty });
      }
    }
  }
  out.deletedProducts.sort((a, b) => a.styleCode.localeCompare(b.styleCode));
  out.removedVariants.sort((a, b) => a.sku.localeCompare(b.sku));
  return out;
}

/** Collapse removed variants into VendorRemoval rows: a color whose variants on the product are ALL removed is one "*" row. */
export function removalRows(removed: RemovedVariant[], allVariants: DbVariantLite[]): { styleCode: string; colorCode: string; shopifySize: string }[] {
  const removedIds = new Set(removed.map((r) => r.variantDbId));
  const rows = new Map<string, { styleCode: string; colorCode: string; shopifySize: string }>();
  for (const r of removed) {
    const colorAll = allVariants.filter((v) => v.productId === r.productId && v.colorCode === r.colorCode);
    const wholeColor = colorAll.every((v) => removedIds.has(v.id));
    const row = { styleCode: r.styleCode, colorCode: r.colorCode, shopifySize: wholeColor ? ANY_SIZE : r.shopifySize };
    rows.set(`${row.styleCode}::${row.colorCode}::${row.shopifySize}`, row);
  }
  return [...rows.values()];
}

export interface RemovalLike {
  colorCode: string;
  shopifySize: string;
}
/** Has the vendor removed this color/size on this product? ("*" = the whole color.) */
export function isRemoved(removals: RemovalLike[], colorCode: string, shopifySize: string): boolean {
  return removals.some((r) => r.colorCode === colorCode && (r.shopifySize === ANY_SIZE || r.shopifySize === shopifySize));
}

/** VendorRemoval rows for one style. Tolerates the table not existing yet (migration not applied): no removals. */
export async function loadRemovals(styleCode: string): Promise<RemovalLike[]> {
  try {
    return await prisma.vendorRemoval.findMany({ where: { styleCode }, select: { colorCode: true, shopifySize: true } });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2021") return [];
    throw e;
  }
}
export async function loadAllRemovals(): Promise<Map<string, RemovalLike[]>> {
  const m = new Map<string, RemovalLike[]>();
  try {
    for (const r of await prisma.vendorRemoval.findMany()) {
      if (!m.has(r.styleCode)) m.set(r.styleCode, []);
      m.get(r.styleCode)!.push(r);
    }
  } catch (e) {
    if ((e as { code?: string })?.code !== "P2021") throw e;
  }
  return m;
}

/** Mark whole-product deletions in DraftJob (create or update). Safe to call repeatedly. */
export async function markDeletedProducts(products: { styleCode: string }[], note: string): Promise<void> {
  for (const p of products) {
    try {
      await prisma.draftJob.upsert({
        where: { styleCode: p.styleCode },
        create: { styleCode: p.styleCode, status: DELETED_BY_VENDOR, error: note },
        update: { status: DELETED_BY_VENDOR, error: note }, // keeps productGid / summary of the draft we created
      });
    } catch (e) {
      if ((e as { code?: string })?.code === "P2021") {
        console.warn("[vendor-deletions] DraftJob table missing — run `npx prisma migrate deploy`; deletion not recorded");
        return;
      }
      throw e;
    }
  }
}

/** Record color/size removals and drop the dead DB rows so nothing re-adds them. */
export async function applyVariantRemovals(removed: RemovedVariant[], allVariants: DbVariantLite[], reason: string): Promise<{ rows: number; deletedVariants: number }> {
  const rows = removalRows(removed, allVariants);
  for (const r of rows) {
    await prisma.vendorRemoval.upsert({
      where: { styleCode_colorCode_shopifySize: r },
      create: { ...r, reason },
      update: { reason },
    });
  }
  const del = await prisma.variant.deleteMany({ where: { id: { in: removed.map((r) => r.variantDbId) } } });
  return { rows: rows.length, deletedVariants: del.count };
}
