import type { Product as DbProduct } from "@prisma/client";
import { prisma } from "./prisma";
import { fetchSkuSheet, isKelmeTokenConfigured } from "./kelme";
import { parseSkuSheet } from "./stock";
import { getProductCategory, type ProductCategory } from "./category";
import type { StoreProduct } from "./types";

function toStoreProduct(row: DbProduct): StoreProduct {
  const categoryOverride = (row.categoryOverride as ProductCategory | null) ?? null;
  return {
    id: row.id,
    pdtid: row.pdtid,
    styleCode: row.styleCode,
    name: row.name,
    colors: row.colors ? row.colors.split(",").map((c) => c.trim()).filter(Boolean) : [],
    imageUrl: row.imageUrl,
    kelmeCatalogPrice: row.kelmeCatalogPrice,
    kelmeFobCost: row.kelmeFobCost,
    active: row.active,
    sellPrice: row.sellPrice,
    discount: row.discount,
    isPublished: row.isPublished,
    category: getProductCategory({ name: row.name, categoryOverride }),
    categoryOverride,
    stock: JSON.parse(row.stock || "[]"),
    stockSyncedAt: row.stockSyncedAt ? row.stockSyncedAt.toISOString() : null,
    colorImages: JSON.parse(row.colorImages || "{}"),
  };
}

export interface StorefrontFilters {
  search?: string;
  color?: string;
  category?: ProductCategory;
}

export interface StorefrontPage {
  products: StoreProduct[];
  hasMore: boolean;
  total: number;
}

// Storefront only ever shows published, active products — the admin views
// below see everything so the vendor can price/publish what's not live yet.
// Category is derived (override ?? auto-guess), not a plain DB column, so
// that filter is applied in JS after the DB-level filters — fine at this
// catalog's scale (~150 rows).
export async function getStorefrontPage(
  page: number,
  pageSize: number,
  filters: StorefrontFilters = {},
): Promise<StorefrontPage> {
  const where = {
    isPublished: true,
    active: true,
    ...(filters.search
      ? {
          OR: [
            { name: { contains: filters.search, mode: "insensitive" as const } },
            { styleCode: { contains: filters.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
    ...(filters.color ? { colors: { contains: filters.color, mode: "insensitive" as const } } : {}),
  };

  const rows = await prisma.product.findMany({ where, orderBy: { name: "asc" } });
  const filtered = rows
    .map(toStoreProduct)
    .filter((p) => !filters.category || p.category === filters.category);

  const start = page * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  return {
    products: slice,
    hasMore: filtered.length > start + pageSize,
    total: filtered.length,
  };
}

export async function getStorefrontProductByStyle(styleCode: string): Promise<StoreProduct | null> {
  const row = await prisma.product.findFirst({
    where: { styleCode, isPublished: true, active: true },
  });
  return row ? toStoreProduct(row) : null;
}

export async function getAllProductsForAdmin(): Promise<StoreProduct[]> {
  const rows = await prisma.product.findMany({ orderBy: { name: "asc" } });
  return rows.map(toStoreProduct);
}

export async function getProductById(id: number): Promise<StoreProduct | null> {
  const row = await prisma.product.findUnique({ where: { id } });
  return row ? toStoreProduct(row) : null;
}

/**
 * Live stock refresh on product open — only runs if a Kelme token is
 * present in env; otherwise the caller should just use the seeded snapshot.
 * Never throws: a failed live call just means we keep serving the existing
 * snapshot (still labeled with its real, older sync timestamp).
 */
export async function refreshProductStock(product: StoreProduct): Promise<StoreProduct> {
  if (!isKelmeTokenConfigured()) return product;

  try {
    const raw = await fetchSkuSheet(product.pdtid);
    const entries = parseSkuSheet(raw, product.styleCode);
    if (entries.length === 0) return product;

    const stockSyncedAt = new Date();
    await prisma.product.update({
      where: { id: product.id },
      data: { stock: JSON.stringify(entries), stockSyncedAt },
    });

    return { ...product, stock: entries, stockSyncedAt: stockSyncedAt.toISOString() };
  } catch {
    return product;
  }
}
