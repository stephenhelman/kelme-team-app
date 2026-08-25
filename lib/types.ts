// A single row as returned by the POC's /inventory endpoint (already parsed
// from Kelme's positional array form).
export interface InventoryRow {
  style: string;
  color: string;
  colorCode: string;
  size: string;
  warehouse: string;
  qty: number;
}

export interface InventoryResponse {
  code: string;
  count: number;
  start: number;
  range: number;
  tokenHeaderPresent: boolean;
  rows: InventoryRow[];
}

export interface WarehouseBreakdown {
  warehouse: string;
  qty: number;
}

// The style + colorCode + sizeLabel tuple is the variant identity — no SKU
// mapping layer, this renders straight from Kelme's own model.
export interface Variant {
  color: string;
  colorCode: string;
  size: string;
  qty: number;
  warehouses: WarehouseBreakdown[];
}

export interface ProductColor {
  color: string;
  colorCode: string;
}

// The inventory-side grouping (Sprint 1). Post-1.5 this is the per-size
// stock overlay joined onto a CatalogProduct by styleCode, not the primary
// catalog itself.
export interface Product {
  style: string;
  colors: ProductColor[];
  variants: Variant[];
  totalQty: number;
}

// A product from the vendor's favorited B2B catalog (Sprint 1.5) — the
// PRIMARY catalog source: real name, price, colors, photo.
export interface CatalogProduct {
  styleCode: string; // `no` — also the join key into inventory Product.style
  name: string; // `note`
  price: number;
  discountPrice: number;
  colors: string[];
  image: string; // `mainpic`, raw upstream URL
  stylename: string;
  id: number;
}
