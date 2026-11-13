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

export const STANDARD_RATE_PER_UNIT = 2.0;
export const EXPRESS_RATE_PER_UNIT = 3.5;
/** Delivery detail shown with each rate at checkout (the rate's description). */
export const STANDARD_DESCRIPTION = "About 20 days after it ships";
export const EXPRESS_DESCRIPTION = "About 10 days after it ships";
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

/** Requests carry at most this many created rates, so a 5-zone batch can't become one enormous payload. */
export const MAX_METHODS_PER_REQUEST = 400;
/** Rates the canary adds per request while ramping up (units; x2 services). */
export const CANARY_RAMP_UNITS = 5;
export const CANARY_PREFIX = "CANARY ";
