/**
 * The rules for turning a Kelme favorite into a Shopify DRAFT — pure (no DB,
 * no Shopify, no Kelme), so the dry-run, the real creator and the daily job all
 * apply exactly the same decisions and the tests pin them.
 *
 * The ONLY things that stop a draft:
 *   - an unknown Kelme size label (not on any chart and not policy-excluded),
 *   - a Shopify API error (raised by the creator, not decided here),
 *   - nothing to create (no variant in a carried size) or a structural fact we
 *     cannot satisfy: a color/size with no Shopify metaobject to link to, or a
 *     product that would need the >100-variant split (not built).
 * Everything else proceeds and becomes a to-do tag/badge for the vendor:
 *   needs-pricing (always), needs-images, needs-category, needs-review.
 */
import { CORE_TAG, EQUIPMENT_SUBCATEGORIES, classifyAudience, type Audience } from "@/lib/shopify-tags";
import { NEEDS_PRICING_TAG, VARIANT_LIMIT, buildTitle, categoryFor, placeholderPrice, type CategoryRule } from "@/lib/shopify-draft-plan";
import { CANONICAL_SIZE_ORDER } from "@/lib/sizes";

export const NEEDS_IMAGES_TAG = "needs-images";
export const NEEDS_CATEGORY_TAG = "needs-category";
export const NEEDS_REVIEW_TAG = "needs-review";

export type DraftTodo = "needs-price" | "needs-images" | "needs-category" | "needs-review";

export interface DraftSourceVariant {
  colorCode: string;
  colorName: string;
  size: string; // our label (carried sizes only)
  qty: number;
  imageUrl: string | null;
}

export interface DraftSource {
  styleCode: string;
  name: string;
  gender: string | null;
  subCategory: string | null;
  kelmeCatalogPrice: number | null;
  variants: DraftSourceVariant[]; // carried sizes only
  leftOff: { size: string; colorCode: string; qty: number }[]; // policy-excluded sizes (4XL+, kids 100/170cm ...)
  unknownSizes: string[]; // raw Kelme labels on no chart
  colorsMissingGid: string[];
  sizesMissingGid: string[];
}

export type CategorySource = "rule" | "live-catalog" | "none";

export interface DraftEvaluation {
  styleCode: string;
  audience: Audience;
  title: string;
  tags: string[];
  category: CategoryRule | null;
  categorySource: CategorySource;
  todos: DraftTodo[];
  blockers: string[];
  price: string;
  sizesCreated: string[];
  sizesLeftOff: string[];
  colors: { code: string; name: string }[];
  colorsMissingImage: string[];
  variantCount: number;
}

export type CategoryMap = Map<string, CategoryRule>; // lower-cased Kelme sub-category -> category used by live products

const rank = (s: string) => {
  const i = CANONICAL_SIZE_ORDER.indexOf(s);
  return i === -1 ? CANONICAL_SIZE_ORDER.length + 1 : i;
};

const bySize = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true });

export function resolveCategory(subCategory: string | null, liveMap: CategoryMap): { category: CategoryRule | null; source: CategorySource } {
  const rule = categoryFor(subCategory);
  if (rule) return { category: rule, source: "rule" };
  const live = subCategory ? liveMap.get(subCategory.trim().toLowerCase()) : undefined;
  if (live) return { category: live, source: "live-catalog" };
  return { category: null, source: "none" };
}

export function evaluateDraft(src: DraftSource, liveCategories: CategoryMap): DraftEvaluation {
  const audience = classifyAudience(src.name, src.gender, src.subCategory);
  const { category, source } = resolveCategory(src.subCategory, liveCategories);

  const colors = new Map<string, string>();
  for (const v of src.variants) if (!colors.has(v.colorCode)) colors.set(v.colorCode, v.colorName);
  const hasImage = new Set(src.variants.filter((v) => v.imageUrl).map((v) => v.colorCode));
  const colorsMissingImage = [...colors.keys()].filter((c) => !hasImage.has(c));

  const sizesCreated = [...new Set(src.variants.map((v) => v.size))].sort(bySize);
  const sizesLeftOff = [...new Set(src.leftOff.map((l) => l.size))].sort(bySize);

  const blockers: string[] = [];
  if (src.variants.length === 0) blockers.push("nothing to create — no variant in a carried size");
  if (src.unknownSizes.length > 0) blockers.push(`unknown Kelme size label(s): ${[...new Set(src.unknownSizes)].join(", ")}`);
  // Linking only happens on a product WITH a category (Shopify refuses linked options without one), so a missing
  // color/size value only blocks categorized products; a no-category draft is created with plain options.
  if (category && src.colorsMissingGid.length > 0) blockers.push(`color(s) with no Shopify color value to link: ${src.colorsMissingGid.join(", ")}`);
  if (category && src.sizesMissingGid.length > 0) blockers.push(`size(s) with no Shopify size value to link: ${src.sizesMissingGid.join(", ")}`);
  if (src.variants.length > VARIANT_LIMIT) blockers.push(`needs the >${VARIANT_LIMIT}-variant split (${src.variants.length} variants) — not automated`);

  const isEquipment = Boolean(src.subCategory && EQUIPMENT_SUBCATEGORIES.has(src.subCategory.trim().toLowerCase()));
  const todos: DraftTodo[] = ["needs-price"];
  if (colorsMissingImage.length > 0) todos.push("needs-images");
  if (!category) todos.push("needs-category");
  // Equipment has no audience by nature (balls, boards ...); only genuinely unclear apparel is flagged for review.
  if (audience === "ambiguous" && !isEquipment) todos.push("needs-review");

  const tags = [CORE_TAG, NEEDS_PRICING_TAG];
  if (audience === "kids") tags.push("Kids");
  else if (audience === "adults") tags.push("Adults");
  if (todos.includes("needs-images")) tags.push(NEEDS_IMAGES_TAG);
  if (todos.includes("needs-category")) tags.push(NEEDS_CATEGORY_TAG);
  if (todos.includes("needs-review")) tags.push(NEEDS_REVIEW_TAG);

  return {
    styleCode: src.styleCode,
    audience,
    title: buildTitle(src.name, audience, src.styleCode),
    tags,
    category,
    categorySource: source,
    todos,
    blockers,
    price: placeholderPrice(src.kelmeCatalogPrice),
    sizesCreated,
    sizesLeftOff,
    colors: [...colors].map(([code, name]) => ({ code, name })),
    colorsMissingImage,
    variantCount: src.variants.length,
  };
}

/** Sizes named in capture's "excluded by policy size" notes, e.g. `excluded by policy size "4XL" (color 100) — ...`. */
export function leftOffFromNotes(notes: string[]): { size: string; colorCode: string; qty: number }[] {
  const out: { size: string; colorCode: string; qty: number }[] = [];
  for (const n of notes) {
    const m = /size "([^"]+)"(?: \(color ([^)]+)\))?/.exec(n);
    if (m) out.push({ size: m[1], colorCode: m[2] ?? "", qty: 0 });
  }
  return out;
}

// --- Category derived from live products ---------------------------------------

/**
 * For each Kelme sub-category, the category the live catalog already uses
 * (the most common one among live products that share that sub-category).
 * `live` rows are Shopify products (with their category) joined to the Kelme
 * sub-category of the DB product carrying the same style code.
 */
export function buildCategoryMap(live: { subCategory: string | null; category: { id: string; fullName: string } | null }[]): CategoryMap {
  const counts = new Map<string, Map<string, { n: number; fullName: string }>>();
  for (const row of live) {
    if (!row.subCategory || !row.category) continue;
    const key = row.subCategory.trim().toLowerCase();
    const byCat = counts.get(key) ?? new Map();
    const cur = byCat.get(row.category.id) ?? { n: 0, fullName: row.category.fullName };
    cur.n++;
    byCat.set(row.category.id, cur);
    counts.set(key, byCat);
  }
  const map: CategoryMap = new Map();
  for (const [key, byCat] of counts) {
    const [id, best] = [...byCat.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))[0];
    map.set(key, { gid: id, label: best.fullName, apparel: best.fullName.startsWith("Apparel & Accessories") });
  }
  return map;
}
