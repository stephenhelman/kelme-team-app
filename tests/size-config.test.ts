import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adultExcluded,
  buildSizeOrder,
  classifySize,
  formatSizeForVendor,
  KIDS_LABELS,
} from "../lib/size-config";
import { CANONICAL_SIZE_ORDER } from "../lib/sizes";
import { evaluatePreflight } from "../lib/shopify-draft-plan";
import { pickUniformPrice, MixedPriceError } from "../lib/shopify-price";

const ok = (raw: string, ball = false) => {
  const c = classifySize(raw, ball);
  assert.equal(c.status, "ok", `${raw} should map`);
  return c.status === "ok" ? c.shopifySize : "";
};

test("kids heights map per the vendor chart (110cm kept as 2)", () => {
  assert.deepEqual(["110", "120", "130", "140", "150", "160"].map((r) => ok(r)), ["2", "4", "6", "8", "10", "12"]);
  const c = classifySize("130", false);
  assert.equal(c.status === "ok" && c.kelmeSize, "130cm");
});

test("kids 100cm and 170cm are policy-excluded, not unknown", () => {
  assert.equal(classifySize("100", false).status, "excluded");
  assert.equal(classifySize("170", false).status, "excluded");
});

test("an unrecognised bare number is unknown (still blocks), not excluded", () => {
  assert.equal(classifySize("180", false).status, "unknown");
  assert.equal(classifySize("90", false).status, "unknown");
});

test("adult: 2XS aliases to XXS; XXS..3XL map", () => {
  assert.equal(ok("2XS"), "XXS");
  for (const s of ["XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL"]) assert.equal(ok(s), s);
});

test("adult 4XL-11XL are policy-excluded by default (decision 2026-11-14: not carried)", () => {
  for (const s of ["4XL", "5XL", "6XL", "7XL", "8XL", "9XL", "10XL", "11XL"]) assert.equal(classifySize(s, false).status, "excluded", s);
  assert.deepEqual(adultExcluded(), ["4XL", "5XL", "6XL", "7XL", "8XL", "9XL", "10XL", "11XL"]);
});

test("ADULT_EXTENDED lifts exclusion for just those sizes (pass 2)", () => {
  const ext = ["4XL", "5XL", "6XL", "7XL"];
  assert.equal(classifySize("5XL", false, { extended: ext }).status, "ok");
  assert.equal(classifySize("8XL", false, { extended: ext }).status, "excluded");
  assert.deepEqual(adultExcluded(ext), ["8XL", "9XL", "10XL", "11XL"]);
});

test("a garbage adult label is unknown-by-allow-list, not excluded", () => {
  const c = classifySize("3XS", false);
  assert.equal(c.status, "ok"); // passes through; the Size-table allow-list then drops and flags it
});

test("ball sizes and One Size are unchanged", () => {
  assert.equal(ok("4", true), "4");
  assert.equal(ok("5", true), "5");
  assert.equal(ok("均码"), "One Size");
  assert.equal(ok(""), "One Size");
});

test("display order: 2 before 4, XXS before XS, One Size last; old 14/16/2XS gone", () => {
  assert.deepEqual(KIDS_LABELS, ["2", "4", "6", "8", "10", "12"]);
  assert.deepEqual(CANONICAL_SIZE_ORDER, ["2", "4", "6", "8", "10", "12", "XXS", "XS", "S", "M", "L", "XL", "2XL", "3XL", "One Size"]);
  assert.deepEqual(buildSizeOrder(["4XL", "5XL"]).slice(-3), ["4XL", "5XL", "One Size"]);
});

test("vendor display: kids sizes show the height, others untouched", () => {
  assert.equal(formatSizeForVendor("6", true), "6 (130cm)");
  assert.equal(formatSizeForVendor("2", true), "2 (110cm)");
  assert.equal(formatSizeForVendor("6", false), "6");
  assert.equal(formatSizeForVendor("M", true), "M");
});

const base = {
  styleCode: "X1",
  name: "Football Set (Kids)",
  gender: "Boys",
  subCategory: "Football Set",
  kelmeCatalogPrice: 10,
  mainpic: "x",
  variants: [{ colorCode: "100", shopifySize: "4", imageUrl: "u" }],
  droppedSizeNotes: [] as string[],
  colorsMissingGid: [] as string[],
  sizesMissingGid: [] as string[],
  familyConflicts: [] as string[],
  unreachableImages: [] as string[],
};

test("pre-flight: policy-excluded sizes are reported as not sold and never block", () => {
  const r = evaluatePreflight({ ...base, excludedSizeNotes: ['excluded by policy size "170cm" (color 100) — not sold, not written'] });
  assert.equal(r.clean, true);
  assert.equal(r.excludedSizeNotes.length, 1);
});

test("pre-flight: unknown/dropped sizes still block", () => {
  const r = evaluatePreflight({ ...base, droppedSizeNotes: ['size "3XS" (color 100) not in Size allow-list — dropped, not written'] });
  assert.equal(r.clean, false);
  assert.ok(r.flags.some((f) => /dropped/.test(f)));
});

test("price guard: uniform price passes, mixed stops with the list, zero refused", () => {
  assert.equal(pickUniformPrice("g", "T", [{ price: "21.5", compareAtPrice: null }, { price: "21.50", compareAtPrice: null }]).price, "21.50");
  assert.throws(() => pickUniformPrice("g", "T", [{ price: "21.50", compareAtPrice: null }, { price: "24.00", compareAtPrice: null }]), (e: unknown) => e instanceof MixedPriceError && e.prices.length === 2);
  assert.throws(() => pickUniformPrice("g", "T", [{ price: "0.00", compareAtPrice: null }]), /zero price/);
});
