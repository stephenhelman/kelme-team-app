import { test } from "node:test";
import assert from "node:assert/strict";
import { auditOrder } from "../lib/order-audit";
import { buildCsv, buildHtml, buildText, sizingFlags, sizingInfos, CSV_HEADER, type VariantInfoLookup } from "../lib/order-sheet";
import type { OrderLineItem, OrderPayload } from "../lib/order-types";
import * as fx from "./fixtures";

// A cart built BEFORE the kids relabel, checked out AFTER: the line still says
// "White / 6" with the old SKU and a roster saved as size "6" — but its variant id
// now points at the 120cm variant, which is labeled "4" after the relabel.
const OLD_SKU = "7710-100-6";
const roster = [1, 2, 3].map((n) => ({ n, number: String(n), name: `P${n}`, size: "6", color: "White" }));

function kidsLine(over: Partial<OrderLineItem> = {}): OrderLineItem {
  return {
    id: 5001,
    product_id: fx.JERSEY,
    variant_id: 777,
    title: "Kelme Kids Jersey",
    variant_title: "White / 6",
    sku: OLD_SKU,
    quantity: 3,
    price: "21.50",
    total_discount: "0.00",
    properties: [
      { name: "Logo Application", value: "Heat Transfer" },
      { name: "Logo Placement", value: "Front" },
      { name: "Number Placement", value: "Back" },
      { name: "Print Color", value: "Black" },
      { name: "_customize_fields", value: "number,name" },
      { name: "_roster_status", value: "complete" },
      { name: "_roster", value: JSON.stringify(roster) },
    ],
    ...over,
  };
}

const order = (l: OrderLineItem): OrderPayload => ({ id: 1, name: "#2001", created_at: "2026-11-20T10:00:00Z", currency: "USD", line_items: [l] });

// DB truth: variant 777 is now "4" / 120cm. The OLD SKU now belongs to the 130cm variant ("6").
const lookup: VariantInfoLookup = {
  byVariantId: new Map([[777, { styleCode: "7710", colorName: "White", size: "4", kelmeSize: "120cm" }]]),
  bySku: new Map([[OLD_SKU, { styleCode: "7710", colorName: "White", size: "6", kelmeSize: "130cm" }]]),
};

const col = (name: (typeof CSV_HEADER)[number]) => CSV_HEADER.indexOf(name);
const rows = (csv: string) => csv.trim().split("\r\n").slice(1).map((r) => r.split(","));

test("old label + old SKU but a variant id that maps to 120cm -> sheet shows '4 (120cm)'", () => {
  const o = order(kidsLine());
  const audit = auditOrder(o, fx.tags);
  const csv = buildCsv(o, audit, lookup);
  const r = rows(csv);
  assert.equal(r.length, 3);
  assert.ok(r.every((x) => x[col("Size")] === "4 (120cm)"), "every unit row shows the current size");
  assert.ok(!csv.includes("130cm") && !csv.includes("6 ("), "the reused SKU's 130cm variant is NOT used");
  const html = buildHtml(o, audit, lookup);
  assert.ok(html.includes("4 (120cm)"));
  assert.ok(buildText(o, audit, lookup).includes("4 (120cm)"));
});

test("roster sizes are replaced with the line's current size and an info note says so", () => {
  const o = order(kidsLine());
  const audit = auditOrder(o, fx.tags);
  const infos = sizingInfos(audit, lookup);
  assert.equal(infos.length, 1);
  assert.match(infos[0], /roster labels updated to current sizing/);
  assert.match(infos[0], /saved as 6, now shown as 4 \(120cm\)/);
  assert.ok(buildHtml(o, audit, lookup).includes("roster labels updated to current sizing"));
  assert.ok(buildText(o, audit, lookup).includes("roster labels updated to current sizing"));
});

test("no info note when the stored roster size already matches", () => {
  const fresh = kidsLine({ properties: kidsLine().properties.map((p) => (p.name === "_roster" ? { ...p, value: JSON.stringify(roster.map((e) => ({ ...e, size: "4" }))) } : p)) });
  const audit = auditOrder(order(fresh), fx.tags);
  assert.deepEqual(sizingInfos(audit, lookup), []);
});

test("resolved by variant id -> no size warning", () => {
  const audit = auditOrder(order(kidsLine()), fx.tags);
  assert.deepEqual(sizingFlags(audit, lookup), []);
});

test("no variant id: falls back to SKU and the line is flagged (reused-SKU risk)", () => {
  const o = order(kidsLine({ variant_id: null }));
  const audit = auditOrder(o, fx.tags);
  const flags = sizingFlags(audit, lookup);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].code, "SIZE_UNVERIFIED");
  assert.match(flags[0].message, /taken from the SKU/);
  // the fallback does use the SKU's (possibly wrong) variant — that's exactly why it is flagged
  assert.ok(buildCsv(o, audit, lookup).includes("6 (130cm)"));
});

test("unknown variant id and unknown SKU: read from the title and flagged", () => {
  const o = order(kidsLine({ variant_id: 999, sku: "NOPE-1-6" }));
  const flags = sizingFlags(auditOrder(o, fx.tags), lookup);
  assert.equal(flags.length, 1);
  assert.match(flags[0].message, /variant title/);
});

test("ball with the same bare number is not annotated with a height", () => {
  const ball: OrderLineItem = { ...kidsLine({ id: 5002, product_id: fx.BALL, variant_id: 888, variant_title: "White / 4", sku: "7710-100-4", properties: [] }) };
  const lk: VariantInfoLookup = { byVariantId: new Map([[888, { styleCode: "7710", colorName: "White", size: "4", kelmeSize: "4" }]]), bySku: new Map() };
  const o = order(ball);
  const csv = buildCsv(o, auditOrder(o, fx.tags), lk);
  assert.ok(!csv.includes("(1") && rows(csv)[0][col("Size")] === "4");
});
