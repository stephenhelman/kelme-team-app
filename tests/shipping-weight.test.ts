import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMutationInput } from "../lib/shopify-reconcile";
import { CORE_WEIGHT_LB } from "../lib/shipping-config";

const target = [
  { styleCode: "9001", colorCode: "110", colorName: "Black", colorGid: "gid://c/1", size: "M", sizeGid: "gid://s/1" },
  { styleCode: "9001", colorCode: "110", colorName: "Black", colorGid: "gid://c/1", size: "L", sizeGid: "gid://s/2" },
];
const colors = [{ name: "Black - 110", gid: "gid://c/1" }];
const sizes = [{ name: "M", gid: "gid://s/1" }, { name: "L", gid: "gid://s/2" }];

test("every core variant is sent at 1 lb and requiresShipping", () => {
  assert.equal(CORE_WEIGHT_LB, 1);
  const input = buildMutationInput(0, colors, sizes, target);
  assert.equal(input.variants.length, 2);
  for (const v of input.variants) {
    assert.deepEqual((v as { inventoryItem?: unknown }).inventoryItem, {
      requiresShipping: true,
      measurement: { weight: { value: 1, unit: "POUNDS" } },
    });
  }
});

test("weight is also sent on the no-size (single-dimension) shape and with a price", () => {
  const input = buildMutationInput(0, colors, [], target.slice(0, 1), null, () => "9.99");
  const v = input.variants[0] as { price?: string; inventoryItem?: { measurement: { weight: { value: number } } } };
  assert.equal(v.price, "9.99");
  assert.equal(v.inventoryItem?.measurement.weight.value, 1);
});

test("canary-only escape hatch omits weight", () => {
  const input = buildMutationInput(0, colors, sizes, target, "Size", undefined, false);
  for (const v of input.variants) assert.equal("inventoryItem" in v, false);
});
