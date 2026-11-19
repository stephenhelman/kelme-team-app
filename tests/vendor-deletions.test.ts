import { test } from "node:test";
import assert from "node:assert/strict";
import { decideJob } from "../lib/draft-jobs";
import { selectPending } from "../lib/draft-run";
import { detectVendorDeletions, isRemoved, removalRows, type DbVariantLite } from "../lib/vendor-deletions";

const v = (id: number, productId: number, style: string, color: string, size: string, vid: string | null, qty = 0): DbVariantLite => ({
  id, productId, styleCode: style, colorCode: color, shopifySize: size, sku: `${style}-${color}-${size}`, qty, shopifyVariantId: vid,
});

test("DELETED_BY_VENDOR: the auto drafter, --all and --resume never recreate; only an explicit create does", () => {
  const row = { status: "DELETED_BY_VENDOR" };
  assert.equal(decideJob(row, false), "skip-deleted");
  assert.equal(decideJob(row, true), "skip-deleted"); // --resume is not an override
  assert.equal(decideJob(row, false, true), "create"); // explicit --styleCode X
  // everything else unchanged
  assert.equal(decideJob(null, false), "create");
  assert.equal(decideJob({ status: "CREATED" }, false), "skip-created");
  assert.equal(decideJob({ status: "FAILED" }, true), "resume");
});

test("selection: a DELETED_BY_VENDOR favorite is never pending, even though it is not on Shopify", () => {
  const favs = ["A1", "B2"].map((no) => ({ id: 1, no, note: no }));
  const s = selectPending(favs, { onShopify: () => false, jobStatus: new Map([["A1", "DELETED_BY_VENDOR"]]) });
  assert.deepEqual(s.pending.map((f) => f.no), ["B2"]);
  assert.deepEqual(s.deletedByVendor, ["A1"]);
});

test("a product whose every linked id is gone and nothing re-matched is a deleted product; its ids are stale", () => {
  const vars = [v(1, 10, "3871001", "100", "S", "gid://V/1", 5), v(2, 10, "3871001", "100", "M", "gid://V/2", 7), v(3, 11, "OTHER", "100", "S", "gid://V/3")];
  const d = detectVendorDeletions(vars, new Set([3]), new Set(["gid://V/3"]));
  assert.deepEqual(d.deletedProducts, [{ productId: 10, styleCode: "3871001", variants: 2, qty: 12 }]);
  assert.deepEqual(d.staleVariantDbIds.sort(), [1, 2]);
  assert.equal(d.removedVariants.length, 0);
});

test("a never-linked product (favorites only) is not a deletion", () => {
  const d = detectVendorDeletions([v(1, 10, "FAV", "100", "S", null)], new Set(), new Set());
  assert.deepEqual(d, { deletedProducts: [], removedVariants: [], staleVariantDbIds: [] });
});

test("an UNLISTED/archived product whose variants still exist is not a deletion", () => {
  const d = detectVendorDeletions([v(1, 10, "K16XLQC028", "000", "One Size", "gid://V/9")], new Set(), new Set(["gid://V/9"]));
  assert.equal(d.deletedProducts.length, 0);
  assert.equal(d.staleVariantDbIds.length, 0);
});

test("K15Z408 case: color 003 M/L deleted on a live product -> removed variants, not a deleted product", () => {
  const vars = [
    v(1, 20, "K15Z408", "003", "L", "gid://V/1"), v(2, 20, "K15Z408", "003", "M", "gid://V/2"),
    v(3, 20, "K15Z408", "010", "M", "gid://V/3", 182), v(4, 20, "K15Z408", "010", "L", "gid://V/4", 251),
  ];
  const d = detectVendorDeletions(vars, new Set([3, 4]), new Set(["gid://V/3", "gid://V/4"]));
  assert.equal(d.deletedProducts.length, 0);
  assert.deepEqual(d.staleVariantDbIds, []); // ids kept until the removal is recorded
  assert.deepEqual(d.removedVariants.map((r) => r.sku), ["K15Z408-003-L", "K15Z408-003-M"]);
  // the whole color is gone -> one "*" row
  assert.deepEqual(removalRows(d.removedVariants, vars), [{ styleCode: "K15Z408", colorCode: "003", shopifySize: "*" }]);
});

test("one size deleted from a color that still has other sizes -> a per-size row, not the whole color", () => {
  const vars = [v(1, 20, "S1", "100", "S", "gid://V/1"), v(2, 20, "S1", "100", "M", "gid://V/2")];
  const d = detectVendorDeletions(vars, new Set([2]), new Set(["gid://V/2"]));
  assert.deepEqual(removalRows(d.removedVariants, vars), [{ styleCode: "S1", colorCode: "100", shopifySize: "S" }]);
});

test("a variant that re-matched under a new id is NOT stale even though its old id is gone", () => {
  const d = detectVendorDeletions([v(1, 20, "S1", "100", "S", "gid://V/old")], new Set([1]), new Set(["gid://V/new"]));
  assert.equal(d.staleVariantDbIds.length, 0);
});

test("isRemoved: '*' blocks the whole color, a size row only that size", () => {
  assert.equal(isRemoved([{ colorCode: "003", shopifySize: "*" }], "003", "XS"), true);
  assert.equal(isRemoved([{ colorCode: "003", shopifySize: "M" }], "003", "L"), false);
  assert.equal(isRemoved([{ colorCode: "003", shopifySize: "M" }], "003", "M"), true);
  assert.equal(isRemoved([{ colorCode: "003", shopifySize: "*" }], "010", "M"), false);
});
