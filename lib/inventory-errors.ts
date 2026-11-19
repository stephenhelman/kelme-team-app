/**
 * Pure helpers for reading inventorySetQuantities userErrors. Dependency-free
 * (no DB, no Shopify) so they can be unit-tested with the real error strings.
 *
 * inventorySetQuantities is all-or-nothing: ONE bad item rejects the whole
 * mutation. Three error codes are attributable to a single item (the field
 * path is ["input","quantities","<i>", ...]) and are therefore "peelable" —
 * the caller drops those items and re-submits the rest:
 *   CHANGE_FROM_QUANTITY_STALE   Shopify's on_hand moved since we read it (CAS conflict; next cycle retries)
 *   INVALID_INVENTORY_ITEM       "The specified inventory item could not be found." (variant/product deleted)
 *   ITEM_NOT_STOCKED_AT_LOCATION the item exists but has no inventory level at our location
 * Anything else (or an error we can't attribute to an index) is not peelable and fails the batch loudly.
 */

export interface SetQuantitiesUserError {
  field: string[] | null;
  message: string;
  code: string | null;
}

export const CAS_STALE_CODE = "CHANGE_FROM_QUANTITY_STALE";
export const UNUSABLE_ITEM_CODES = ["INVALID_INVENTORY_ITEM", "ITEM_NOT_STOCKED_AT_LOCATION"] as const;

export interface UnusableItem {
  index: number;
  code: string;
  message: string;
}

export interface ClassifiedErrors {
  /** indexes that lost the compare-and-swap */
  staleIndexes: number[];
  /** items that cannot be written at all (deleted / not stocked) */
  unusable: UnusableItem[];
}

/** The quantity index a userError points at, or null if it can't be attributed. */
export function errorIndex(e: SetQuantitiesUserError, count: number): number | null {
  const idx = Number(e.field?.find((part, i) => i > 0 && e.field![i - 1] === "quantities"));
  return Number.isInteger(idx) && idx >= 0 && idx < count ? idx : null;
}

/** null = at least one error is not peelable (or not attributable) — the whole batch must be treated as failed. */
export function classifyUserErrors(errors: SetQuantitiesUserError[], count: number): ClassifiedErrors | null {
  const stale = new Set<number>();
  const unusable = new Map<number, UnusableItem>();
  for (const e of errors) {
    const idx = errorIndex(e, count);
    if (idx === null) return null;
    if (e.code === CAS_STALE_CODE) stale.add(idx);
    else if (e.code && (UNUSABLE_ITEM_CODES as readonly string[]).includes(e.code)) unusable.set(idx, { index: idx, code: e.code, message: e.message });
    else return null;
  }
  return { staleIndexes: [...stale], unusable: [...unusable.values()] };
}

/**
 * Does a push-failure message mean "this inventory item no longer exists on Shopify" (=> relink)? Matches the
 * userError code directly, so it works for one error or many (the old regex only matched by accident when >= 2).
 */
const STALE_ID_RE = /INVALID_INVENTORY_ITEM|ITEM_NOT_STOCKED_AT_LOCATION|could not be found|could not find|does not exist|not found/i;
export function isStaleIdMessage(message: string | undefined | null): boolean {
  return !!message && STALE_ID_RE.test(message);
}
