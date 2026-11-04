import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTiers, checkCarts, diffLadder, exactTier, expectedPrice, pricedUnits, stepTier, type ObservedRate } from "../lib/shipping-tiers";

const observedFrom = (name: string, perUnit: number, tiers = buildTiers()): ObservedRate[] =>
  tiers.map((t) => ({ name, price: (Math.round(t.units * perUnit * 100) / 100).toFixed(2), minLb: t.minLb, maxLb: t.maxLb }));

test("boundaries: >= N-0.5 and <= N+0.4", () => {
  assert.deepEqual(exactTier(25), { minLb: 24.5, maxLb: 25.4, units: 25 });
  assert.deepEqual(stepTier(40, 45), { minLb: 40.5, maxLb: 45.4, units: 45 });
});

test("ladder: exact to EXACT_UP_TO, steps of 5 to MAX, no gaps between whole lbs", () => {
  const t = buildTiers(40, 300);
  assert.equal(t.length, 40 + 52);
  assert.equal(t[39].units, 40);
  assert.equal(t[40].units, 45);
  assert.equal(t.at(-1)!.units, 300);
  for (let w = 1; w <= 300; w++) assert.equal(t.filter((x) => w >= x.minLb && w <= x.maxLb).length, 1, `weight ${w}`);
});

test("short final step when MAX isn't a multiple of 5 from EXACT_UP_TO", () => {
  const t = buildTiers(40, 302);
  assert.equal(t.at(-1)!.units, 302);
  assert.equal(t.at(-1)!.minLb, 300.5);
});

test("pricing at the upper edge: never undercharge", () => {
  assert.equal(expectedPrice(25, 2.7), "67.50");
  assert.equal(expectedPrice(26, 4.2), "109.20");
  assert.equal(expectedPrice(40, 2.7), "108.00");
  assert.equal(expectedPrice(41, 2.7), "121.50"); // 45u
  assert.equal(expectedPrice(137, 2.7), "378.00"); // 140u
  assert.equal(expectedPrice(300, 4.2), "1260.00");
  assert.equal(expectedPrice(301, 2.7), null);
  assert.equal(pricedUnits(137), 140);
});

test("a correct ladder produces no mismatches; a wrong price / missing tier is named", () => {
  const live = [...observedFrom("Standard Shipping", 2.7), ...observedFrom("Express Shipping", 4.2), { name: "Request a quote", price: "0.00", minLb: 300.5, maxLb: null }];
  assert.deepEqual(diffLadder("z", live, buildTiers()), []);
  assert.deepEqual(checkCarts("z", live, [25, 26, 40, 137, 300]), []);
  const bad = live.filter((r) => !(r.name === "Standard Shipping" && r.minLb === 24.5));
  bad.find((r) => r.name === "Express Shipping" && r.minLb === 40.5)!.price = "1.00";
  const d = diffLadder("z", bad, buildTiers()).map((m) => m.what);
  assert.equal(d.length, 2);
  assert.match(d[0], /Standard Shipping tier 24.5-25.4 .* MISSING/);
  assert.match(d[1], /Express Shipping tier 40.5-45.4 lb price \$1.00, expected \$189.00/);
  assert.equal(checkCarts("z", bad, [25]).length, 1);
});

import { planRequests, tierMethod, type MethodCreate, type ZoneWork } from "../lib/shipping-profile";
import { MAX_METHODS_PER_REQUEST, ZONES_PER_REQUEST } from "../lib/shipping-config";

const work = (id: string, n: number): ZoneWork => ({
  zoneId: id,
  zoneName: id,
  deleteIds: [`del-${id}`],
  create: Array.from({ length: n }, (_, i) => ({ name: `m${i}` }) as unknown as MethodCreate),
});

test("planRequests: <=5 zones and <=MAX methods per request, deletes sent once, nothing lost", () => {
  const zones = Array.from({ length: 12 }, (_, i) => work(`z${i}`, 184));
  const reqs = planRequests(zones);
  let created = 0;
  const deletes: string[] = [];
  for (const r of reqs) {
    assert.ok(r.length <= ZONES_PER_REQUEST);
    assert.ok(r.reduce((n, w) => n + w.create.length, 0) <= MAX_METHODS_PER_REQUEST);
    created += r.reduce((n, w) => n + w.create.length, 0);
    deletes.push(...r.flatMap((w) => w.deleteIds));
  }
  assert.equal(created, 12 * 184);
  assert.equal(deletes.length, 12);
  // a single oversized zone is chunked across requests
  const big = planRequests([work("big", MAX_METHODS_PER_REQUEST * 2 + 1)]);
  assert.equal(big.length, 3);
  assert.equal(big.flat().flatMap((w) => w.deleteIds).length, 1);
});

test("tierMethod payload: inclusive weight bounds in pounds, price at upper edge", () => {
  const m = tierMethod("Standard Shipping", 2.7, exactTier(26), "USD");
  assert.equal(m.rateDefinition.price.amount, "70.20");
  assert.deepEqual(m.weightConditionsToCreate, [
    { operator: "GREATER_THAN_OR_EQUAL_TO", criteria: { value: 25.5, unit: "POUNDS" } },
    { operator: "LESS_THAN_OR_EQUAL_TO", criteria: { value: 26.4, unit: "POUNDS" } },
  ]);
});
