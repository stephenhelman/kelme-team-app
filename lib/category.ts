export type ProductCategory = "team" | "coach" | "equipment";

export const CATEGORIES: ProductCategory[] = ["team", "coach", "equipment"];

export const CATEGORY_LABELS: Record<ProductCategory, string> = {
  team: "Team",
  coach: "Coach",
  equipment: "Equipment",
};

/**
 * Swappable auto-guess rule — best-guess from the product name until a real
 * Kelme dim-id -> bucket mapping replaces it. Keep this function's signature
 * (name in, ProductCategory out) so that swap is a one-function change; the
 * matching order matters (equipment/coach checked before falling through to
 * the team default).
 */
function guessCategoryFromName(name: string): ProductCategory {
  const n = name.toLowerCase();
  if (/\b(ball|cone|bag|board|tactic)\b/.test(n)) return "equipment";
  if (/\b(coach|staff)\b/.test(n)) return "coach";
  return "team";
}

// A stored per-product override always wins over the auto-guess rule.
export function getProductCategory(product: { name: string; categoryOverride: string | null }): ProductCategory {
  if (product.categoryOverride && CATEGORIES.includes(product.categoryOverride as ProductCategory)) {
    return product.categoryOverride as ProductCategory;
  }
  return guessCategoryFromName(product.name);
}
