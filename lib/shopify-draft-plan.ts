/**
 * Pure planning for draft product creation — no DB, no Shopify, no Kelme.
 * Everything a draft needs (title, tags, taxonomy category, description,
 * image filenames, placeholder price) is derived here from the stored
 * Product/Variant rows, so the dry-run can print exactly what --execute
 * would send and the unit tests can pin the conventions.
 *
 * Conventions derived from the live catalog (284 products, read 2026-11-03):
 *   - title    "<Brand> <product name> - <Kids|Adults> - <styleCode>"
 *              e.g. "Kelme Soccer Jersey  - Kids - 7351TX3093"
 *   - tags     every real product carries `core` (checkout 25-item minimum);
 *              apparel also carries Kids|Adults (classifyAudience)
 *   - category apparel lives under Apparel & Accessories (aa-*) so the
 *              shopify.size linked option is valid; see CATEGORY_RULES
 */
import { classifyAudience, CORE_TAG, type Audience } from "@/lib/shopify-tags";

export const DRAFT_VENDOR = "KELME";
export const TITLE_BRAND = "KELME";
export const NEEDS_PRICING_TAG = "needs-pricing";
export const VARIANT_LIMIT = 100;

// --- Category -------------------------------------------------------------
//
// Keyed on Kelme's `Sub-category` attribute (lowercased). Every GID below is
// one already in use on live products in this shop, so it is known-valid for
// the API version and known to accept the shopify.size / shopify.color-pattern
// linked options. A sub-category with no rule is NOT guessed — the product is
// flagged "no category mapping" in the pre-flight and cannot be drafted.
export interface CategoryRule {
  gid: string;
  label: string;
  apparel: boolean; // true = Apparel & Accessories taxonomy (shopify.size linkable)
}

const SPORTS_UNIFORMS: CategoryRule = {
  gid: "gid://shopify/TaxonomyCategory/aa-1-21-7",
  label: "Apparel & Accessories > Clothing > Uniforms > Sports Uniforms",
  apparel: true,
};
const SHORTS: CategoryRule = {
  gid: "gid://shopify/TaxonomyCategory/aa-1-1-1-3",
  label: "Apparel & Accessories > Clothing > Activewear > Activewear Pants > Shorts",
  apparel: true,
};
const JACKETS: CategoryRule = {
  gid: "gid://shopify/TaxonomyCategory/aa-1-1-8-2",
  label: "Apparel & Accessories > Clothing > Activewear > Activewear Vests & Jackets > Jackets",
  apparel: true,
};
const SOCKS: CategoryRule = {
  gid: "gid://shopify/TaxonomyCategory/aa-1-18-2",
  label: "Apparel & Accessories > Clothing > Socks > Athletic Socks",
  apparel: true,
};

const CATEGORY_RULES: Record<string, CategoryRule> = {
  "football set": SPORTS_UNIFORMS,
  "goalkeeper uniform": SPORTS_UNIFORMS,
  "volleyball uniform": SPORTS_UNIFORMS,
  "refree shirt": SPORTS_UNIFORMS, // sic — Kelme's spelling
  "pingpong&badminton uniform": SPORTS_UNIFORMS,
  "football shorts": SHORTS,
  "goalkeeper pants": SHORTS,
  "knitted jacket": JACKETS,
  "woven jacket": JACKETS,
  "football socks": SOCKS,
};

export function categoryFor(subCategory: string | null | undefined): CategoryRule | null {
  if (!subCategory) return null;
  return CATEGORY_RULES[subCategory.trim().toLowerCase()] ?? null;
}

// --- Title ----------------------------------------------------------------

// Audience words live in the Kelme name ("Training Set (Men)", "… (Kids)");
// the live title format carries audience as its own " - Kids|Adults - "
// segment instead, so strip them from the descriptive part.
const AUDIENCE_PAREN_RE = /\s*\((kids|adults?|men'?s?|women'?s?|boys?|girls?)\)/gi;

export function cleanProductName(name: string): string {
  return name.replace(AUDIENCE_PAREN_RE, "").replace(/\s+/g, " ").trim();
}

export function buildTitle(name: string, audience: Audience, styleCode: string): string {
  const base = `${TITLE_BRAND} ${cleanProductName(name)}`;
  if (audience === "ambiguous") return `${base} - ${styleCode}`;
  return `${base} - ${audience === "kids" ? "Kids" : "Adults"} - ${styleCode}`;
}

// --- Tags -----------------------------------------------------------------

export function buildTags(audience: Audience): string[] {
  const tags = [CORE_TAG, NEEDS_PRICING_TAG];
  if (audience === "kids") tags.push("Kids");
  else if (audience === "adults") tags.push("Adults");
  return tags;
}

// --- Description ----------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface DescriptionSource {
  name: string;
  kelmeDescription: string | null;
  composition: string | null;
  function: string | null;
  seasons: string | null;
  collection: string | null;
}

export function buildDescriptionHtml(p: DescriptionSource): string {
  const lead = (p.kelmeDescription ?? "").trim() || cleanProductName(p.name);
  const facts: [string, string | null][] = [
    ["Material", p.composition],
    ["Function", p.function],
    ["Season", p.seasons],
    ["Collection", p.collection],
  ];
  const items = facts
    .filter(([, v]) => v && v.trim() !== "")
    .map(([k, v]) => `<li><strong>${k}:</strong> ${esc((v as string).trim())}</li>`);
  return `<p>${esc(lead)}</p>` + (items.length > 0 ? `\n<ul>\n${items.join("\n")}\n</ul>` : "");
}

// --- Price ----------------------------------------------------------------

// Placeholder only — the `needs-pricing` tag is the vendor's to-do marker.
export function placeholderPrice(kelmeCatalogPrice: number | null): string {
  return typeof kelmeCatalogPrice === "number" && kelmeCatalogPrice > 0 ? kelmeCatalogPrice.toFixed(2) : "0.00";
}

// --- Images ---------------------------------------------------------------

export interface ImagePlanEntry {
  colorCode: string;
  sourceUrl: string; // Kelme URL
  filename: string; // {style}_{code}_{seq}.ext — the pattern lib/shopify-media.ts parses
  mimeType: string;
}

const MIME_BY_EXT: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

// One image per color. Kelme's own filenames already follow the pattern
// ({styleCode}_{colorCode}_{seq}.jpg, which is how Variant.imageUrl was
// chosen), so the filename is kept verbatim when it parses; otherwise it is
// rebuilt as {style}_{code}_01.{ext}. Returns null for a color with no image.
export function planImage(styleCode: string, colorCode: string, imageUrl: string | null): ImagePlanEntry | null {
  if (!imageUrl) return null;
  const raw = imageUrl.split("?")[0].split("/").pop() ?? "";
  const ext = (raw.split(".").pop() ?? "jpg").toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) return null;
  const m = raw.match(/^(.+)_(\w+)_(\d+)\.\w+$/);
  const filename = m && m[1] === styleCode && m[2] === colorCode ? raw : `${styleCode}_${colorCode}_01.${ext}`;
  return { colorCode, sourceUrl: imageUrl, filename, mimeType };
}

// --- Pre-flight evaluation ---------------------------------------------------

export interface PreflightInput {
  styleCode: string;
  name: string;
  gender: string | null;
  subCategory: string | null;
  kelmeCatalogPrice: number | null;
  mainpic: string;
  variants: { colorCode: string; shopifySize: string; imageUrl: string | null }[];
  droppedSizeNotes: string[]; // capture warnings: sizes dropped by the Size allow-list / unmapped (BLOCKS)
  excludedSizeNotes?: string[]; // policy-excluded sizes (lib/size-config.ts): reported as "not sold", never a flag
  colorsMissingGid: string[]; // colorCodes lacking Color.shopifyGid
  sizesMissingGid: string[]; // sizes lacking the GID the product's option kind needs
  familyConflicts: string[]; // sibling DB style codes and/or existing Shopify titles claiming this code
  unreachableImages: string[]; // colorCodes whose image HEAD failed (empty when not checked)
}

export interface PreflightResult {
  styleCode: string;
  name: string;
  audience: Audience;
  category: CategoryRule | null;
  variantCount: number;
  colorCount: number;
  sizes: string[];
  needsSplit: boolean;
  droppedSizeNotes: string[];
  excludedSizeNotes: string[]; // "not sold" — informational only
  colorsMissingGid: string[];
  sizesMissingGid: string[];
  familyConflicts: string[];
  colorsMissingImage: string[];
  unreachableImages: string[];
  flags: string[]; // empty = clean
  clean: boolean;
  simpleApparel: boolean; // clean AND apparel taxonomy AND a real size dimension — a valid spike candidate
}

export function evaluatePreflight(i: PreflightInput): PreflightResult {
  const audience = classifyAudience(i.name, i.gender, i.subCategory);
  const category = categoryFor(i.subCategory);
  const colors = [...new Set(i.variants.map((v) => v.colorCode))];
  const sizes = [...new Set(i.variants.map((v) => v.shopifySize))];
  const imageByColor = new Map<string, string | null>();
  for (const v of i.variants) if (!imageByColor.has(v.colorCode) || v.imageUrl) imageByColor.set(v.colorCode, v.imageUrl);
  const colorsMissingImage = colors.filter((c) => !imageByColor.get(c));

  const flags: string[] = [];
  if (i.variants.length === 0) flags.push("no variants after capture (Kelme returned no stocked colors/sizes)");
  if (i.variants.length > VARIANT_LIMIT) flags.push(`needs split: ${i.variants.length} variants > ${VARIANT_LIMIT}`);
  if (i.droppedSizeNotes.length > 0) flags.push(`${i.droppedSizeNotes.length} size(s) dropped by capture`);
  if (i.colorsMissingGid.length > 0) flags.push(`colors without shopifyGid: ${i.colorsMissingGid.join(",")}`);
  if (i.sizesMissingGid.length > 0) flags.push(`sizes without shopifyGid: ${i.sizesMissingGid.join(",")}`);
  if (i.familyConflicts.length > 0) flags.push(`style-code family conflict: ${i.familyConflicts.join("; ")}`);
  if (colorsMissingImage.length > 0) flags.push(`colors missing image: ${colorsMissingImage.join(",")}`);
  if (i.unreachableImages.length > 0) flags.push(`image URL unreachable for colors: ${i.unreachableImages.join(",")}`);
  if (!category) flags.push(`no category mapping for sub-category "${i.subCategory ?? ""}"`);
  if (category?.apparel && audience === "ambiguous") flags.push("audience ambiguous (no Kids/Adults tag derivable)");

  const clean = flags.length === 0;
  const hasSizeDimension = !(sizes.length === 1 && sizes[0] === "One Size");
  return {
    styleCode: i.styleCode,
    name: i.name,
    audience,
    category,
    variantCount: i.variants.length,
    colorCount: colors.length,
    sizes,
    needsSplit: i.variants.length > VARIANT_LIMIT,
    droppedSizeNotes: i.droppedSizeNotes,
    excludedSizeNotes: i.excludedSizeNotes ?? [],
    colorsMissingGid: i.colorsMissingGid,
    sizesMissingGid: i.sizesMissingGid,
    familyConflicts: i.familyConflicts,
    colorsMissingImage,
    unreachableImages: i.unreachableImages,
    flags,
    clean,
    simpleApparel: clean && Boolean(category?.apparel) && hasSizeDimension,
  };
}
