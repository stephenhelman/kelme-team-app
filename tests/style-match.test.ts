import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_TAG, computeTargetTags } from "../lib/shopify-tags";
import { colorBelongsToTitle, matchingStyleCodes, pickSubProduct, titleBaseGroup, titleHasStyleCode } from "../lib/style-match";

test("exact suffixed code matches only itself", () => {
  const title = "KELME Net - K16XLQC026-1";
  assert.equal(titleHasStyleCode(title, "K16XLQC026-1"), true);
  assert.equal(titleHasStyleCode(title, "K16XLQC026"), false);
  assert.equal(titleHasStyleCode(title, "K16XLQC026-2"), false);
});

test("base code matches a plain title and ignores year-like hyphen tails", () => {
  assert.equal(titleHasStyleCode("Kelme Jersey - Kids - 7351TX3093 - (Until 2026)", "7351TX3093"), true);
  assert.equal(titleHasStyleCode("Kelme Jersey 7351TX3093-2026", "7351TX3093"), true);
});

test("whole-token: shorter code does not match a longer one", () => {
  assert.deepEqual(matchingStyleCodes("Kelme Thing K15Z408L", ["K15Z408", "K15Z408L"]), ["K15Z408L"]);
});

test("a title listing both base and suffixed codes matches both (legitimately combined product)", () => {
  assert.deepEqual(
    matchingStyleCodes("Agility Rings - K16XLQC010/K16XLQC010-1", ["K16XLQC010", "K16XLQC010-1"]).sort(),
    ["K16XLQC010", "K16XLQC010-1"],
  );
});

test("split family: base label parsing and color ownership", () => {
  const black = "Kelme Jersey - Kids - 7351TX3093 - (Until 2026) (Black Base)";
  const other = "Kelme Jersey - Kids - 7351TX3093 - (Until 2026) (Other Base)";
  assert.equal(titleBaseGroup(black), "Black Base");
  assert.equal(titleBaseGroup(other), "Other");
  assert.equal(titleBaseGroup("Kelme Jersey - 7351TX3093"), null);
  assert.equal(colorBelongsToTitle(black, "020"), true);
  assert.equal(colorBelongsToTitle(black, "100"), false);
  assert.equal(colorBelongsToTitle(other, "416"), true);
  assert.equal(colorBelongsToTitle("Kelme Jersey - 7351TX3093", "100"), true);
});

test("pickSubProduct narrows a split family by group, stays ambiguous without one", () => {
  const family = ["Black", "White", "Other"].map((g) => ({ title: `Jersey 7351TX3093 (${g} Base)` }));
  assert.equal(pickSubProduct(family).length, 3);
  assert.deepEqual(pickSubProduct(family, "White Base").map((p) => p.title), ["Jersey 7351TX3093 (White Base)"]);
  const plain = [{ title: "Jersey 7351TX3093" }];
  assert.equal(pickSubProduct(plain, "White Base").length, 1);
});

test("tag target adds core and never strips existing tags", () => {
  const out = computeTargetTags(["Soccer Uniform", "customizable-tops", "Kids"], "adults");
  assert.ok(out.includes(CORE_TAG));
  assert.ok(out.includes("Adults") && !out.includes("Kids"));
  assert.ok(out.includes("Soccer Uniform") && out.includes("customizable-tops"));
  assert.equal(computeTargetTags(["core", "Adults"], "adults").filter((t) => t === "core").length, 1);
});
