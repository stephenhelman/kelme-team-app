import { test } from "node:test";
import assert from "node:assert/strict";
import { variantInput } from "../lib/size-bulk";

const spec = { sku: "7451ZB1795-600-5XL", colorOptionValue: "Red - 600", colorGid: "gid://shopify/Metaobject/1", size: "5XL", sizeGid: "gid://shopify/Metaobject/2", price: "39.00" };

test("bulk-create variant: linked Color+Size values, product price, 1 lb, ships, tracked, SKU", () => {
  const v = variantInput(spec);
  assert.equal(v.price, "39.00");
  assert.deepEqual(v.optionValues, [
    { optionName: "Color", name: "Red - 600", linkedMetafieldValue: "gid://shopify/Metaobject/1" },
    { optionName: "Size", name: "5XL", linkedMetafieldValue: "gid://shopify/Metaobject/2" },
  ]);
  assert.equal(v.inventoryItem.sku, "7451ZB1795-600-5XL");
  assert.equal(v.inventoryItem.tracked, true);
  assert.equal(v.inventoryItem.requiresShipping, true);
  assert.deepEqual(v.inventoryItem.measurement, { weight: { value: 1, unit: "POUNDS" } });
});

test("bulk-create variant never carries inventory quantities (the Kelme push sets stock)", () => {
  assert.equal("inventoryQuantities" in variantInput(spec), false);
});
