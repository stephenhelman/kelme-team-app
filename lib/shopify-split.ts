/**
 * Splits an oversized product's colors into Shopify's 100-variant
 * synchronous productSet limit by grouping colors into three base
 * families, derived purely from Kelme's 3-digit colorCode convention —
 * 0xx = black-family, 1xx = white-family, everything else (including all
 * 4-digit codes, a separate numbering scheme) = Other. Pure logic, no
 * Shopify calls — read/write against Shopify is a separate concern.
 */

export type BaseGroup = "Black Base" | "White Base" | "Other";

export function baseGroup(colorCode: string): BaseGroup {
  if (colorCode.length === 3) {
    if (colorCode[0] === "0") return "Black Base";
    if (colorCode[0] === "1") return "White Base";
    return "Other";
  }
  return "Other";
}

export interface SplitColorInput {
  colorCode: string;
  colorName: string;
}

export interface SplitColorGroup {
  group: BaseGroup;
  colors: SplitColorInput[];
  variantCount: number; // colors.length * sizeCount
}

// sizeCount is the product's full size set size — every base group carries
// the same sizes, only colors are partitioned.
export function splitColorsByBase(colors: SplitColorInput[], sizeCount: number): SplitColorGroup[] {
  const buckets: Record<BaseGroup, SplitColorInput[]> = {
    "Black Base": [],
    "White Base": [],
    Other: [],
  };
  for (const c of colors) {
    buckets[baseGroup(c.colorCode)].push(c);
  }
  const order: BaseGroup[] = ["Black Base", "White Base", "Other"];
  return order.map((group) => ({
    group,
    colors: buckets[group],
    variantCount: buckets[group].length * sizeCount,
  }));
}
