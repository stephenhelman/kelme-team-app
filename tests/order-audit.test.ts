import { test } from "node:test";
import assert from "node:assert/strict";
import { auditOrder, digitCount, expectedFeesForLine, parseCustomization, placementMultiplier } from "../lib/order-audit";
import * as fx from "./fixtures";

const codes = (r: ReturnType<typeof auditOrder>) => r.flags.map((f) => f.code);

test("digitCount counts digits only", () => {
  assert.equal(digitCount("7"), 1);
  assert.equal(digitCount("10"), 2);
  assert.equal(digitCount("00"), 2);
  assert.equal(digitCount(""), 0);
});

test("placement: Both doubles; blank is x1; anything else is unconfirmed (x1)", () => {
  assert.deepEqual(placementMultiplier("Both"), { multiplier: 2, known: true });
  assert.deepEqual(placementMultiplier("both "), { multiplier: 2, known: true });
  assert.deepEqual(placementMultiplier(""), { multiplier: 1, known: true });
  assert.deepEqual(placementMultiplier("Front"), { multiplier: 1, known: false });
});

test("#1028: expected fees match observed units (50 heat, 82 number digits, 25 names)", () => {
  const units = { heat: 0, number: 0, name: 0 } as Record<string, number>;
  for (const line of fx.order1028.line_items) {
    const c = parseCustomization(line);
    if (!c) continue;
    for (const f of expectedFeesForLine(c)) units[f.kind] += f.units;
  }
  assert.deepEqual(units, { heat: 50, number: 82, name: 25 });
});

test("#1028 correct order: no flags, fee dollars exact", () => {
  const r = auditOrder(fx.order1028, fx.tags);
  assert.deepEqual(r.flags, []);
  assert.equal(r.coreCount, 27); // 25 jerseys + 2 balls; fee lines are not core
  assert.deepEqual(
    r.fees.map((f) => [f.kind, f.expectedUnits, f.expectedAmount, f.actualUnits, f.actualAmount]),
    [["heat", 50, 145, 50, 145], ["number", 82, 164, 82, 164], ["name", 25, 50, 25, 50]],
  );
  assert.equal(r.feeLines.length, 3);
  assert.equal(r.plainLines.length, 1);
});

test("tampered: all fee lines removed -> FEES_MISSING with the full dollar amount", () => {
  const r = auditOrder(fx.orderFeesStripped, fx.tags);
  assert.deepEqual(codes(r), ["FEES_MISSING"]);
  assert.equal(r.flags[0].shortfall, 359); // 145 + 164 + 50
});

test("tampered: heat fee halved (placement doubling unpaid) -> FEE_SHORTFALL of $72.50", () => {
  const r = auditOrder(fx.orderHeatShort, fx.tags);
  assert.deepEqual(codes(r), ["FEE_SHORTFALL"]);
  assert.equal(r.flags[0].shortfall, 72.5);
  assert.match(r.flags[0].message, /Heat Transfer/);
});

test("under-25 core order is flagged; its correct Patch/number/name fees are not", () => {
  const r = auditOrder(fx.orderUnder25, fx.tags);
  assert.deepEqual(codes(r), ["LOW_CORE_COUNT"]);
  assert.equal(r.coreCount, 12);
  // patch 12 x 4.00 = 48; numbers 1-12 = 15 digits x 2.00 = 30
  assert.deepEqual(r.fees.find((f) => f.kind === "patch")?.expectedAmount, 48);
  assert.deepEqual(r.fees.find((f) => f.kind === "number")?.expectedUnits, 15);
});

test("pending roster is flagged (and not double-reported as a count mismatch)", () => {
  const r = auditOrder(fx.orderPendingRoster, fx.tags);
  assert.deepEqual(codes(r), ["ROSTER_PENDING"]);
});

test("roster count != quantity is flagged", () => {
  const order = structuredClone(fx.order1028);
  const jersey = order.line_items[0];
  const rosterProp = jersey.properties.find((p) => p.name === "_roster")!;
  rosterProp.value = JSON.stringify(JSON.parse(rosterProp.value).slice(0, 13));
  const r = auditOrder(order, fx.tags);
  assert.ok(codes(r).includes("ROSTER_COUNT_MISMATCH"));
});

test("unknown placement value is flagged, not guessed", () => {
  const order = structuredClone(fx.order1028);
  for (const l of order.line_items) {
    const p = l.properties.find((x) => x.name === "Logo Placement");
    if (p) p.value = "Sleeve";
  }
  const r = auditOrder(order, fx.tags);
  assert.ok(codes(r).includes("UNKNOWN_PLACEMENT"));
  // Checked as a single placement: 25 heat units expected vs 50 charged — an overcharge is not a shortfall.
  assert.ok(!codes(r).includes("FEE_SHORTFALL"));
});

test("plain order: no customization, no flags", () => {
  const r = auditOrder(fx.orderPlain, fx.tags);
  assert.deepEqual(r.flags, []);
  assert.equal(r.customized.length, 0);
  assert.equal(r.coreCount, 30);
});

test("line whose product tags can't be found is flagged and not counted as core", () => {
  const r = auditOrder(fx.orderPlain, new Map());
  assert.ok(codes(r).includes("UNCLASSIFIED_LINE"));
  assert.ok(codes(r).includes("LOW_CORE_COUNT"));
});

test("non-Shopify logo URL is flagged as suspicious", () => {
  const order = structuredClone(fx.order1028);
  order.line_items[0].properties.find((p) => p.name === "Logo")!.value = "https://evil.example.com/uploads/x.png";
  assert.ok(codes(auditOrder(order, fx.tags)).includes("LOGO_URL_SUSPICIOUS"));
});
