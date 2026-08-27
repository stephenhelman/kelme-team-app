import { CATEGORIES, type ProductCategory } from "./category";

export interface ProductPatch {
  sellPrice?: number | null;
  discount?: number | null;
  isPublished?: boolean;
  categoryOverride?: ProductCategory | null;
}

// Vendor-owned commerce fields only — never touches Kelme-owned columns.
export function sanitizeProductPatch(body: unknown): ProductPatch {
  const input = (body ?? {}) as Record<string, unknown>;
  const data: ProductPatch = {};

  if ("sellPrice" in input) data.sellPrice = input.sellPrice === null ? null : Number(input.sellPrice);
  if ("discount" in input) data.discount = input.discount === null ? null : Number(input.discount);
  if ("isPublished" in input) data.isPublished = Boolean(input.isPublished);
  if ("categoryOverride" in input) {
    data.categoryOverride =
      input.categoryOverride && CATEGORIES.includes(input.categoryOverride as ProductCategory)
        ? (input.categoryOverride as ProductCategory)
        : null;
  }

  return data;
}
