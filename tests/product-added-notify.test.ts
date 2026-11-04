import { test } from "node:test";
import assert from "node:assert/strict";
import { renderProductsAddedEmail, type AddedProduct } from "../lib/product-added-notify";

const p = (over: Partial<AddedProduct> = {}): AddedProduct => ({
  title: "KELME Short Sleeve Football Set - Adults - 9151ZB1001",
  styleCode: "9151ZB1001",
  shopifyProductId: "gid://shopify/Product/123",
  status: "DRAFT",
  category: "Apparel & Accessories > Clothing > Uniforms > Sports Uniforms",
  variantCount: 24,
  colorCount: 4,
  sizes: ["S", "M"],
  imagesAttached: 4,
  totalQty: 1,
  variantsInStock: 1,
  price: "21.80",
  needsPricing: true,
  ...over,
});

test("single product: subject, counts, admin link, needs-pricing note", () => {
  const m = renderProductsAddedEmail([p()], "https://shop.example/admin");
  assert.equal(m.subject, "1 new Kelme product added to your store — drafts awaiting pricing");
  assert.match(m.html, /https:\/\/shop\.example\/admin\/products\/123/);
  assert.match(m.text, /24 variants/);
  assert.match(m.text, /needs pricing/);
  assert.match(m.html, /Sports Uniforms/);
});

test("multiple products total their variants; escapes titles", () => {
  const m = renderProductsAddedEmail([p({ title: "A <b> & B" }), p({ shopifyProductId: "gid://shopify/Product/9", variantCount: 6 })], "https://s/admin/");
  assert.match(m.subject, /^2 new Kelme products/);
  assert.match(m.text, /30 variants in total/);
  assert.match(m.html, /A &lt;b&gt; &amp; B/);
  assert.match(m.html, /https:\/\/s\/admin\/products\/9/);
});

test("no pricing note when nothing needs pricing", () => {
  const m = renderProductsAddedEmail([p({ needsPricing: false })], "https://s/admin");
  assert.doesNotMatch(m.subject, /awaiting pricing/);
  assert.doesNotMatch(m.text, /needs pricing/);
});
