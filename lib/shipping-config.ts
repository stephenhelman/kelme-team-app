/**
 * Per-unit shipping via weight tiers. Every core variant weighs exactly
 * 1 lb and ships; customize_charge fee items weigh 0 and don't ship, so a
 * cart's total weight == its core unit count. Rates are weight tiers on the
 * General profile (scripts/shipping-rates.ts). Change a rate or cap here only.
 */

export const CORE_WEIGHT_LB = 1;
export const CORE_REQUIRES_SHIPPING = true;
export const FEE_WEIGHT_LB = 0;
export const FEE_REQUIRES_SHIPPING = false;

/** Fee product titles (tagged customize_charge). */
export const FEE_PRODUCT_TITLES = ["Heat Transfer Product", "Patch Product", "Number Customization", "Name Customization"];

export const STANDARD_RATE_PER_UNIT = 2.7;
export const EXPRESS_RATE_PER_UNIT = 4.2;
export const STANDARD_NAME = "Standard Shipping";
export const EXPRESS_NAME = "Express Shipping";

/** Exact one-unit-wide tiers up to this unit count... */
export const EXACT_UP_TO = 40;
/** ...then tiers of this many units, priced at the upper edge, up to MAX_UNITS. */
export const STEP_UNITS = 5;
export const MAX_UNITS = 300;
/** Above the top tier the existing "Request a quote" fallback applies. */
export const FALLBACK_RATE_NAME = "Request a quote";

/** Max zones per deliveryProfileUpdate request. */
export const ZONES_PER_REQUEST = 5;

export interface WeightTier {
  /** Inclusive lower bound, lb. */
  minLb: number;
  /** Inclusive upper bound, lb. */
  maxLb: number;
  /** Largest unit count this tier covers; the price is units * per-unit rate. */
  units: number;
}

/**
 * Exact tier for n units: >= n-0.5 and <= n+0.4 lb (so n lb always lands in
 * it and the 0.1 lb gap to n+1's lower bound can't be hit by a whole-lb cart).
 */
export function exactTier(n: number): WeightTier {
  return { minLb: n - 0.5, maxLb: n + 0.4, units: n };
}

/** Stepped tier ending at `top` units, covering (top-STEP_UNITS, top], priced at `top`. */
export function stepTier(top: number): WeightTier {
  return { minLb: top - STEP_UNITS + 0.5, maxLb: top + 0.4, units: top };
}

/** Full tier ladder: exact 1..exactUpTo, then steps of 5 to maxUnits (priced at upper edge). */
export function buildTiers(exactUpTo = EXACT_UP_TO, maxUnits = MAX_UNITS): WeightTier[] {
  const tiers: WeightTier[] = [];
  for (let n = 1; n <= exactUpTo; n++) tiers.push(exactTier(n));
  let top = exactUpTo;
  while (top < maxUnits) {
    top = Math.min(top + STEP_UNITS, maxUnits);
    tiers.push(stepTier(top));
  }
  return tiers;
}

export const money2 = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
