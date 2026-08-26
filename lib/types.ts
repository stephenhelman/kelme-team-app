import type { ProductCategory } from "./category";

// Sprint 2: the DB-backed store product. Kelme-owned fields come from the
// seed/refresh; sellPrice/discount/isPublished are vendor-owned, set only
// in admin and never overwritten by a Kelme sync.
export interface StoreProduct {
  id: number;
  pdtid: number;
  styleCode: string;
  name: string;
  colors: string[];
  imageUrl: string;
  kelmeCatalogPrice: number;
  kelmeFobCost: number;
  active: boolean;

  sellPrice: number | null;
  discount: number | null;
  isPublished: boolean;

  // Effective storefront bucket (override ?? auto-guess — see lib/category.ts)
  // and the raw override itself, so admin can show/clear it.
  category: ProductCategory;
  categoryOverride: ProductCategory | null;

  stock: StockEntry[];
  stockSyncedAt: string | null;

  // colorCode -> resolved image URL, or null if that color has no dedicated
  // photo (checked server-side at seed/refresh time — see lib/stock.ts).
  colorImages: Record<string, string | null>;
}

// One color x size cell from the sku-sheet's "Headquarters Inventory" row.
export interface StockEntry {
  color: string;
  colorCode: string;
  size: string;
  qty: number;
}
