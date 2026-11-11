// Single source of truth for which sizes we sell, how Kelme labels map to ours,
// and which Kelme sizes are deliberately NOT sold. Dependency-free (pure
// modules such as lib/sizes.ts and lib/order-sheet.ts import it).
//
// Vendor chart (kids height -> our label):
//   110cm -> 2 (kept by decision), 120 -> 4, 130 -> 6, 140 -> 8, 150 -> 10, 160 -> 12
//
// Three outcomes for any Kelme size label (see classifySize):
//   ok        mapped to a label we sell
//   excluded  POLICY: a real size we choose not to sell. Never blocks draft
//             creation; reported as "not sold".
//   unknown   not recognised at all. Still blocks and is flagged.
// Whether a mapped label can actually be written also depends on the DB Size
// table (the allow-list + Shopify GID source); a label that maps but isn't
// there yet is a flagged "dropped", same as before.

/** Kelme kids height -> our label. */
export const KIDS_CM_TO_LABEL: Record<string, string> = {
  "110cm": "2",
  "120cm": "4",
  "130cm": "6",
  "140cm": "8",
  "150cm": "10",
  "160cm": "12",
};

/** Kids heights Kelme sells that we deliberately do not. */
export const KIDS_EXCLUDED_CM: string[] = ["100cm", "170cm"];

/** Kelme adult label -> our label. */
export const ADULT_ALIASES: Record<string, string> = { "2XS": "XXS" };

export const ADULT_BASE: string[] = ["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL"];

/** Pass 2: sold above 3XL. They also need Size rows + Shopify GIDs (`npm run sizes -- seed`). 8XL+ stay policy-excluded. */
export const ADULT_EXTENDED: string[] = ["4XL", "5XL", "6XL", "7XL"];

/** Every adult size above 3XL that Kelme sends; whatever is not in ADULT_EXTENDED is policy-excluded. */
const ADULT_ABOVE_BASE = ["4XL", "5XL", "6XL", "7XL", "8XL", "9XL", "10XL", "11XL"];

export function adultExcluded(extended: readonly string[] = ADULT_EXTENDED): string[] {
  return ADULT_ABOVE_BASE.filter((s) => !extended.includes(s));
}

/** Our kids labels in ascending order ("2" before "4"). */
export const KIDS_LABELS: string[] = Object.values(KIDS_CM_TO_LABEL).sort((a, b) => Number(a) - Number(b));

/** Reverse map used to show "6 (130cm)" on vendor documents. */
export const KIDS_LABEL_TO_CM: Record<string, string> = Object.fromEntries(
  Object.entries(KIDS_CM_TO_LABEL).map(([cm, label]) => [label, cm]),
);

/** Capture warning prefix for policy-excluded sizes; deliberately matches none of the "dropped" patterns the pre-flight blocks on. */
export const EXCLUDED_NOTE_PREFIX = "excluded by policy size";

export const ONE_SIZE_LABEL = "One Size";

/** Canonical display order: kids ascending, adults XXS..3XL (+ extended), One Size. Unknown sizes sort last. */
export function buildSizeOrder(extended: readonly string[] = ADULT_EXTENDED): string[] {
  return [...KIDS_LABELS, ...ADULT_BASE, ...extended, ONE_SIZE_LABEL];
}

/** Every label the policy says we sell on apparel (what the Size table should hold, plus One Size/balls). */
export function sellableApparelLabels(extended: readonly string[] = ADULT_EXTENDED): string[] {
  return [...KIDS_LABELS, ...ADULT_BASE, ...extended];
}

export type SizeClass =
  | { status: "ok"; kelmeSize: string; shopifySize: string }
  | { status: "excluded"; kelmeSize: string; reason: string }
  | { status: "unknown"; kelmeSize: string };

/**
 * Classify one raw Kelme size label. `isBall` products keep the label as-is.
 * A bare number on a non-ball product is a kids height in cm.
 */
export function classifySize(
  rawLabel: string,
  isBall: boolean,
  opts: { extended?: readonly string[] } = {},
): SizeClass {
  const extended = opts.extended ?? ADULT_EXTENDED;
  if (isBall) return { status: "ok", kelmeSize: rawLabel, shopifySize: rawLabel };

  if (/^\d+$/.test(rawLabel)) {
    const cm = `${rawLabel}cm`;
    const label = KIDS_CM_TO_LABEL[cm];
    if (label) return { status: "ok", kelmeSize: cm, shopifySize: label };
    if (KIDS_EXCLUDED_CM.includes(cm)) return { status: "excluded", kelmeSize: cm, reason: `kids ${cm} is not on the size chart` };
    return { status: "unknown", kelmeSize: cm };
  }

  // Kelme's one-size label is Chinese (均码); blank is treated the same.
  if (rawLabel === "均码" || rawLabel.trim() === "") return { status: "ok", kelmeSize: rawLabel, shopifySize: ONE_SIZE_LABEL };

  const label = ADULT_ALIASES[rawLabel] ?? rawLabel;
  if (adultExcluded(extended).includes(label)) return { status: "excluded", kelmeSize: rawLabel, reason: `adult ${label} is not sold` };
  // Anything else passes through; the Size-table allow-list decides (unknown labels get flagged there).
  return { status: "ok", kelmeSize: rawLabel, shopifySize: label };
}

/** "6" -> "6 (130cm)" for kids lines on vendor documents; everything else unchanged. */
export function formatSizeForVendor(size: string, isKidsLine: boolean): string {
  if (!isKidsLine) return size;
  const cm = KIDS_LABEL_TO_CM[size];
  return cm ? `${size} (${cm})` : size;
}
