import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDescriptionHtml,
  buildTags,
  buildTitle,
  categoryFor,
  cleanProductName,
  evaluatePreflight,
  placeholderPrice,
  planImage,
} from "../lib/shopify-draft-plan";
import { familyConflictsFor } from "../lib/draft-preflight";

test("title follows the live '<Brand> <name> - <Audience> - <style>' format", () => {
  assert.equal(cleanProductName("Short Sleeve Football Set (Adults)"), "Short Sleeve Football Set");
  assert.equal(buildTitle("Short Sleeve Football Set (Adults)", "adults", "9151ZB1001"), "KELME Short Sleeve Football Set - Adults - 9151ZB1001");
  assert.equal(buildTitle("Goalkeeper Shorts (Kids)", "kids", "K15Z408C"), "KELME Goalkeeper Shorts - Kids - K15Z408C");
  assert.equal(buildTitle("Ball Bag", "ambiguous", "9886019"), "KELME Ball Bag - 9886019");
});

test("tags: core + needs-pricing + audience", () => {
  assert.deepEqual(buildTags("kids"), ["core", "needs-pricing", "Kids"]);
  assert.deepEqual(buildTags("adults"), ["core", "needs-pricing", "Adults"]);
  assert.deepEqual(buildTags("ambiguous"), ["core", "needs-pricing"]);
});

test("category: known sub-categories map, unknown ones do not", () => {
  assert.match(categoryFor("Football Set")!.gid, /aa-1-21-7$/);
  assert.match(categoryFor(" Football Shorts ")!.gid, /aa-1-1-1-3$/);
  assert.equal(categoryFor("Training Device"), null);
  assert.equal(categoryFor(null), null);
});

test("placeholder price", () => {
  assert.equal(placeholderPrice(21.8), "21.80");
  assert.equal(placeholderPrice(null), "0.00");
  assert.equal(placeholderPrice(0), "0.00");
});

test("description escapes and omits empty facts", () => {
  const html = buildDescriptionHtml({ name: "X", kelmeDescription: "A <b> & C", composition: "100% Polyester", function: null, seasons: " ", collection: null });
  assert.match(html, /^<p>A &lt;b&gt; &amp; C<\/p>/);
  assert.match(html, /<li><strong>Material:<\/strong> 100% Polyester<\/li>/);
  assert.doesNotMatch(html, /Function|Season/);
});

test("image filename keeps the {style}_{code}_{seq}.ext pattern", () => {
  const e = planImage("9151ZB1001", "100", "http://h/product/normal/9151ZB1001_100_01.jpg")!;
  assert.equal(e.filename, "9151ZB1001_100_01.jpg");
  assert.equal(e.mimeType, "image/jpeg");
  assert.equal(planImage("9151ZB1001", "100", "http://h/other.JPG")!.filename, "9151ZB1001_100_01.jpg");
  assert.equal(planImage("9151ZB1001", "100", null), null);
  assert.equal(planImage("9151ZB1001", "100", "http://h/a.bmp"), null);
});

const base = {
  styleCode: "9151ZB1001",
  name: "Short Sleeve Football Set (Adults)",
  gender: "Men",
  subCategory: "Football Set",
  kelmeCatalogPrice: 21.8,
  mainpic: "x",
  droppedSizeNotes: [],
  colorsMissingGid: [],
  sizesMissingGid: [],
  familyConflicts: [],
  unreachableImages: [],
};
const v = (colorCode: string, shopifySize: string, imageUrl: string | null = "u") => ({ colorCode, shopifySize, imageUrl });

test("preflight: clean simple apparel", () => {
  const r = evaluatePreflight({ ...base, variants: [v("100", "S"), v("100", "M")] });
  assert.equal(r.clean, true);
  assert.equal(r.simpleApparel, true);
});

test("preflight: every flag reason is surfaced", () => {
  const r = evaluatePreflight({
    ...base,
    subCategory: "Training Device",
    droppedSizeNotes: ["size 4XL dropped"],
    colorsMissingGid: ["999"],
    familyConflicts: ["sibling"],
    variants: [v("100", "S", null)],
  });
  assert.equal(r.clean, false);
  assert.equal(r.simpleApparel, false);
  for (const needle of ["dropped", "without shopifyGid", "family conflict", "missing image", "no category mapping"]) {
    assert.ok(r.flags.some((f) => f.includes(needle)), needle);
  }
});

test("preflight: >100 variants needs split", () => {
  const variants = Array.from({ length: 101 }, (_, i) => v(String(i), "S"));
  const r = evaluatePreflight({ ...base, variants });
  assert.equal(r.needsSplit, true);
  assert.equal(r.clean, false);
});

test("family conflicts: siblings by stem and existing Shopify titles", () => {
  const out = familyConflictsFor("K16XLQC026", ["K16XLQC026", "K16XLQC026-1", "OTHER"], [
    { id: "1", title: "KELME Net - K16XLQC026-1", status: "ACTIVE" },
    { id: "2", title: "KELME Net - K16XLQC026", status: "UNLISTED" },
  ]);
  assert.equal(out.length, 2);
  assert.match(out[0], /K16XLQC026-1/);
  assert.match(out[1], /UNLISTED/);
});
