import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCategoryMap, evaluateDraft, leftOffFromNotes, type DraftSource } from "../lib/draft-rules";
import { decideJob } from "../lib/draft-jobs";

const v = (colorCode: string, size: string, imageUrl: string | null = "http://x/a.jpg", qty = 5) => ({ colorCode, colorName: `C${colorCode}`, size, qty, imageUrl });
const base = (over: Partial<DraftSource> = {}): DraftSource => ({
  styleCode: "3801098", name: "Soccer Uniform Jersey and Shorts (Men)", gender: "Men", subCategory: "Football Set", kelmeCatalogPrice: 24.7,
  variants: [v("100", "S"), v("100", "M"), v("201", "S"), v("201", "M")], leftOff: [], unknownSizes: [], colorsMissingGid: [], sizesMissingGid: [], ...over,
});
const none = new Map();

test("a normal product passes with core + needs-pricing + audience tag and only the price to-do", () => {
  const e = evaluateDraft(base(), none);
  assert.deepEqual(e.blockers, []);
  assert.deepEqual(e.tags, ["core", "needs-pricing", "Adults"]);
  assert.deepEqual(e.todos, ["needs-price"]);
  assert.equal(e.price, "24.70");
  assert.match(e.title, /^KELME .* - Adults - 3801098$/);
});

test("the ONLY content blockers are unknown size labels (and nothing to create / unlinkable values)", () => {
  assert.match(evaluateDraft(base({ unknownSizes: ["3XS"] }), none).blockers[0], /unknown Kelme size label/);
  assert.match(evaluateDraft(base({ variants: [] }), none).blockers[0], /nothing to create/);
  // everything else proceeds: no images, no category, ambiguous audience, family-style suffix codes
  const e = evaluateDraft(base({ styleCode: "K16XLQC010-1", name: "Training Thing", gender: null, subCategory: "Weird Sub", variants: [v("100", "S", null)] }), none);
  assert.deepEqual(e.blockers, []);
});

test("missing images: draft is still created, tagged needs-images, only for the colors lacking one", () => {
  const e = evaluateDraft(base({ variants: [v("100", "S"), v("201", "S", null)] }), none);
  assert.deepEqual(e.blockers, []);
  assert.ok(e.todos.includes("needs-images"));
  assert.ok(e.tags.includes("needs-images"));
  assert.deepEqual(e.colorsMissingImage, ["201"]);
});

test("category: hard rule first, then the live catalog's category for that sub-category, else needs-category", () => {
  assert.equal(evaluateDraft(base(), none).categorySource, "rule");
  const live = buildCategoryMap([
    { subCategory: "Training Pants", category: { id: "gid://shopify/TaxonomyCategory/aa-1-1-1-3", fullName: "Apparel & Accessories > Clothing > Activewear > Activewear Pants > Shorts" } },
    { subCategory: "Training Pants", category: { id: "gid://shopify/TaxonomyCategory/aa-1-1-1-3", fullName: "Apparel & Accessories > Clothing > Activewear > Activewear Pants > Shorts" } },
    { subCategory: "Training Pants", category: { id: "gid://shopify/TaxonomyCategory/aa-9", fullName: "Apparel & Accessories > Other" } },
  ]);
  const derived = evaluateDraft(base({ subCategory: "Training Pants" }), live);
  assert.equal(derived.categorySource, "live-catalog");
  assert.equal(derived.category?.gid, "gid://shopify/TaxonomyCategory/aa-1-1-1-3"); // most common wins
  assert.equal(derived.category?.apparel, true);
  const none2 = evaluateDraft(base({ subCategory: "Never Seen" }), live);
  assert.equal(none2.category, null);
  assert.ok(none2.tags.includes("needs-category") && none2.todos.includes("needs-category"));
  assert.deepEqual(none2.blockers, []);
});

test("audience: Kelme gender, then the title; still ambiguous => no Kids/Adults tag and needs-review", () => {
  assert.equal(evaluateDraft(base({ name: "Training Jacket", gender: "Boys" }), none).audience, "kids");
  const amb = evaluateDraft(base({ name: "Training Jacket", gender: null }), none);
  assert.equal(amb.audience, "ambiguous");
  assert.ok(!amb.tags.includes("Kids") && !amb.tags.includes("Adults"));
  assert.ok(amb.tags.includes("needs-review") && amb.todos.includes("needs-review"));
  assert.doesNotMatch(amb.title, /- (Kids|Adults) -/);
});

test("equipment has no audience by nature and is not tagged needs-review", () => {
  const e = evaluateDraft(base({ name: "Soccer Ball Hand Stitched", gender: null, subCategory: "Football Ball", variants: [v("100", "5")] }), none);
  assert.equal(e.audience, "ambiguous");
  assert.ok(!e.todos.includes("needs-review"));
  assert.ok(!e.tags.includes("Kids") && !e.tags.includes("Adults"));
});

test("sizes: created sizes in chart order, left-off sizes reported, price placeholder never blocks", () => {
  const e = evaluateDraft(base({ variants: [v("100", "XL"), v("100", "S"), v("100", "XXS")], leftOff: [{ size: "5XL", colorCode: "100", qty: 3 }, { size: "4XL", colorCode: "100", qty: 1 }], kelmeCatalogPrice: null }), none);
  assert.deepEqual(e.sizesCreated, ["XXS", "S", "XL"]);
  assert.deepEqual(e.sizesLeftOff, ["4XL", "5XL"]);
  assert.equal(e.price, "0.00");
  assert.deepEqual(e.blockers, []);
});

test("leftOffFromNotes reads capture's excluded-size notes", () => {
  const l = leftOffFromNotes(['excluded by policy size "4XL" (color 100) — not sold, not written', 'excluded by policy size "170cm" (color 205) — not sold, not written']);
  assert.deepEqual(l.map((x) => `${x.size}/${x.colorCode}`), ["4XL/100", "170cm/205"]);
});

test("DraftJob lock: created is skipped, interrupted/failed needs a human, blocked is re-evaluated, resume only when asked", () => {
  assert.equal(decideJob(null, false), "create");
  assert.equal(decideJob({ status: "BLOCKED" }, false), "create");
  assert.equal(decideJob({ status: "CREATED" }, false), "skip-created");
  assert.equal(decideJob({ status: "CREATED" }, true), "skip-created");
  assert.equal(decideJob({ status: "CREATING" }, false), "skip-needs-human");
  assert.equal(decideJob({ status: "FAILED" }, false), "skip-needs-human");
  assert.equal(decideJob({ status: "FAILED" }, true), "resume");
});
