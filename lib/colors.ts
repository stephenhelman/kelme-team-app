import type { StoreProduct } from "./types";

// Color names come from the parsed sku-sheet stock when we have it (richer —
// matches the color codes used for images/availability); otherwise fall
// back to the favorites endpoint's plain color list.
export function getProductColorNames(product: StoreProduct): string[] {
  const fromStock = [...new Set(product.stock.map((s) => s.color))].filter(Boolean);
  return fromStock.length > 0 ? fromStock : product.colors;
}
