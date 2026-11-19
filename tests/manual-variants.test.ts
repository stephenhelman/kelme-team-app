import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeManualVariants, type RemovalContext, type ShopifyVariantLite } from "../lib/manual-variants";

const base = (over: Partial<ShopifyVariantLite> = {}): ShopifyVariantLite => ({
  id: "gid://shopify/ProductVariant/1", productGid: "gid://shopify/Product/1", productTitle: "KELME Short Sleeve Football Set - Adults - 9151ZB1001",
  sku: "", itemSku: "", color: "White - 100", size: "XS", onHand: 0, price: "35.80", createdAt: "2026-11-18T21:49:00Z", ...over,
});
const ctx = (over: Partial<RemovalContext> = {}): RemovalContext => ({
  targetSize: "XS",
  styleOf: () => "9151ZB1001",
  colorCodeOf: (c) => c.split(" - ").pop() ?? null,
  dbLinkedVariantIds: new Set(),
  kelmeDeclares: () => false,
  orderedVariantIds: new Set(),
  ...over,
});

test("a hand-made, unlinked, zero-stock XS that Kelme does not declare and nobody ordered is removable", () => {
  const [v] = judgeManualVariants([base()], ctx());
  assert.equal(v.remove, true);
  assert.deepEqual(v.reasons, []);
  assert.equal(v.colorCode, "100");
});

test("other sizes are ignored entirely", () => {
  assert.equal(judgeManualVariants([base({ size: "M" })], ctx()).length, 0);
});

test("a SKU (variant or inventory item) means it is ours, never removed", () => {
  assert.equal(judgeManualVariants([base({ sku: "9151ZB1001-100-XS" })], ctx())[0].remove, false);
  assert.equal(judgeManualVariants([base({ itemSku: "X" })], ctx())[0].remove, false);
});

test("a DB-linked variant is never removed", () => {
  const r = judgeManualVariants([base()], ctx({ dbLinkedVariantIds: new Set(["gid://shopify/ProductVariant/1"]) }))[0];
  assert.equal(r.remove, false);
  assert.match(r.reasons.join(), /DB variant is linked/);
});

test("if Kelme now declares that color/size the variant is kept", () => {
  const r = judgeManualVariants([base()], ctx({ kelmeDeclares: (s, c, z) => s === "9151ZB1001" && c === "100" && z === "XS" }))[0];
  assert.equal(r.remove, false);
  assert.match(r.reasons.join(), /Kelme now declares/);
});

test("stock on hand, or an order referencing the variant, blocks removal", () => {
  assert.equal(judgeManualVariants([base({ onHand: 3 })], ctx())[0].remove, false);
  assert.equal(judgeManualVariants([base()], ctx({ orderedVariantIds: new Set(["gid://shopify/ProductVariant/1"]) }))[0].remove, false);
  assert.equal(judgeManualVariants([base({ onHand: null })], ctx())[0].remove, true); // no level at the location = nothing to lose
});

test("a product whose title doesn't resolve to exactly one style is never touched", () => {
  assert.equal(judgeManualVariants([base()], ctx({ styleOf: () => null }))[0].remove, false);
});
