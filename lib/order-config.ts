/**
 * Single place for order-intake business rules: fee rates, tags, the core-item
 * minimum, and placement multipliers. The audit (lib/order-audit.ts) reads
 * everything from here — change a rate or rule here only.
 */

// Product tags (set on the Shopify products).
export const CORE_TAG = "core";
export const FEE_TAG = "customization-fee";

// Store rule, enforced at checkout by the B'sure app; the audit re-checks it.
export const MIN_CORE_ITEMS = 25;

export type FeeKind = "patch" | "heat" | "number" | "name";

export interface FeeKindConfig {
  label: string;
  /** What one billed unit is, for the summary ("50 logo applications"). */
  unit: string;
  /** Dollars per unit. */
  rate: number;
  /**
   * Fee products are recognised by FEE_TAG, but the tag doesn't say WHICH fee
   * a line is — that's matched on the product title (first match in
   * FEE_KIND_ORDER wins). Observed titles: "Name Customization",
   * "Number Customization", "Heat Transfer Product"; the Patch product's
   * title is assumed to contain "patch". A fee-tagged line matching none of
   * these is flagged, never silently ignored.
   */
  titlePattern: RegExp;
}

export const FEE_KINDS: Record<FeeKind, FeeKindConfig> = {
  patch: { label: "Patch logo", unit: "logo", rate: 4.0, titlePattern: /patch/i },
  heat: { label: "Heat Transfer logo", unit: "logo", rate: 2.9, titlePattern: /heat\s*transfer/i },
  number: { label: "Numbers", unit: "digit", rate: 2.0, titlePattern: /number/i },
  name: { label: "Names", unit: "name", rate: 2.0, titlePattern: /name/i },
};

// Order matters: "Heat Transfer Product" must not fall through to a looser pattern.
export const FEE_KIND_ORDER: FeeKind[] = ["heat", "patch", "number", "name"];

/**
 * Placement values (Logo Placement / Number Placement line properties) that
 * multiply a fee's units, keyed lowercase. Only "Both" is confirmed (logo and
 * number fees double). Any other non-blank value is treated as x1 AND flagged
 * as unconfirmed rather than guessed — add confirmed values here.
 */
export const PLACEMENT_MULTIPLIERS: Record<string, number> = {
  both: 2,
};

/** Allowed hosts for the Logo property URL (rendered as an image + link in the email). */
export const LOGO_URL_HOSTS = ["cdn.shopify.com"];
