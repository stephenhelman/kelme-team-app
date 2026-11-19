import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUserErrors, isStaleIdMessage, type SetQuantitiesUserError } from "../lib/inventory-errors";
import {
  VERIFY_MISMATCH_ALERT_THRESHOLD,
  flipAlertBody,
  shouldRecordSuccessfulSync,
  shouldRelink,
  skippedStaleAlertBody,
} from "../lib/sync-policy";

const invalid = (i: number): SetQuantitiesUserError => ({
  field: ["input", "quantities", String(i), "inventoryItemId"],
  message: "The specified inventory item could not be found.",
  code: "INVALID_INVENTORY_ITEM",
});
const notStocked = (i: number): SetQuantitiesUserError => ({
  field: ["input", "quantities", String(i), "locationId"],
  message: "The specified inventory item is not stocked at the location.",
  code: "ITEM_NOT_STOCKED_AT_LOCATION",
});
const stale = (i: number): SetQuantitiesUserError => ({
  field: ["input", "quantities", String(i), "changeFromQuantity"],
  message: "The quantity has changed.",
  code: "CHANGE_FROM_QUANTITY_STALE",
});

// The exact strings executePush's catch/log produced: "inventorySetQuantities userErrors: " + JSON.
const asMessage = (errs: SetQuantitiesUserError[]) => `inventorySetQuantities userErrors: ${JSON.stringify(errs)}`;

test("STALE_ID matching: a single INVALID_INVENTORY_ITEM error matches (the old regex missed it)", () => {
  assert.equal(isStaleIdMessage(asMessage([invalid(3)])), true);
});

test("STALE_ID matching: two or more errors match", () => {
  assert.equal(isStaleIdMessage(asMessage([invalid(0), invalid(1)])), true);
  assert.equal(isStaleIdMessage(asMessage([invalid(0), notStocked(1), invalid(2)])), true);
});

test("STALE_ID matching: unrelated failures do not trigger a relink", () => {
  assert.equal(isStaleIdMessage("inventorySetQuantities GraphQL error: [{\"message\":\"Throttled\"}]"), false);
  assert.equal(isStaleIdMessage(asMessage([stale(0)])), false);
  assert.equal(isStaleIdMessage(undefined), false);
});

test("a single invalid item is peeled, nothing else is touched", () => {
  assert.deepEqual(classifyUserErrors([invalid(7)], 100), {
    staleIndexes: [],
    unusable: [{ index: 7, code: "INVALID_INVENTORY_ITEM", message: "The specified inventory item could not be found." }],
  });
});

test("two invalid items + a CAS conflict + a not-stocked item are all peeled in one pass", () => {
  const c = classifyUserErrors([invalid(0), invalid(5), stale(2), notStocked(9)], 100)!;
  assert.deepEqual(c.staleIndexes, [2]);
  assert.deepEqual(c.unusable.map((u) => [u.index, u.code]), [[0, "INVALID_INVENTORY_ITEM"], [5, "INVALID_INVENTORY_ITEM"], [9, "ITEM_NOT_STOCKED_AT_LOCATION"]]);
});

test("one item reported twice is peeled once", () => {
  const c = classifyUserErrors([invalid(4), { ...invalid(4), field: ["input", "quantities", "4", "locationId"] }], 10)!;
  assert.equal(c.unusable.length, 1);
});

test("an unknown error code is NOT peelable: the batch is reported failed (null)", () => {
  assert.equal(classifyUserErrors([invalid(0), { field: ["input", "quantities", "1", "quantity"], message: "bad", code: "INVALID_QUANTITY_TOO_HIGH" }], 10), null);
});

test("an error that can't be attributed to an index is NOT peelable", () => {
  assert.equal(classifyUserErrors([{ field: ["input"], message: "x", code: "INVALID_INVENTORY_ITEM" }], 10), null);
  assert.equal(classifyUserErrors([invalid(50)], 10), null); // index out of range
});

test("a batch with 1 bad item in 100: peeling leaves the other 99 to be re-submitted", () => {
  const batch = Array.from({ length: 100 }, (_, i) => i);
  const c = classifyUserErrors([invalid(42)], batch.length)!;
  const drop = new Set(c.unusable.map((u) => u.index));
  const rest = batch.filter((i) => !drop.has(i));
  assert.equal(rest.length, 99);
  assert.ok(!rest.includes(42));
});

test("heartbeat only advances when the push had no failures", () => {
  assert.equal(shouldRecordSuccessfulSync(0), true);
  assert.equal(shouldRecordSuccessfulSync(1), false);
  assert.equal(shouldRecordSuccessfulSync(277), false);
});

test("relink triggers on skipped_stale, or on failures that carry a stale-id message — not on other failures", () => {
  assert.equal(shouldRelink({ skippedStale: 2, failed: 0, hasStaleIdFailure: false }), true);
  assert.equal(shouldRelink({ skippedStale: 0, failed: 5, hasStaleIdFailure: true }), true);
  assert.equal(shouldRelink({ skippedStale: 0, failed: 5, hasStaleIdFailure: false }), false);
  assert.equal(shouldRelink({ skippedStale: 0, failed: 0, hasStaleIdFailure: false }), false);
});

test("alert bodies list the offenders", () => {
  const body = skippedStaleAlertBody([{ variantId: 1, inventoryItemGid: "gid://x/1", message: "gone" }], new Map([[1, "K15Z408-003-L"]]));
  assert.match(body, /K15Z408-003-L: gone/);
  const flip = flipAlertBody([{ styleCode: "3871001", variants: 68, qty: 3995 }]);
  assert.match(flip, /3871001: 68 variants, 3995 units/);
  assert.equal(VERIFY_MISMATCH_ALERT_THRESHOLD, 20);
});
