import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRenames, valueInput, type ValueGroup } from "../lib/size-relabel";

const gids: Record<string, string> = { "2": "g2", "4": "g4", "6": "g6", "8": "g8", "10": "g10", "12": "g12" };
const gid = (l: string) => gids[l] ?? null;
const g = (name: string, cm: string, linked = "old"): ValueGroup => ({ valueId: `v${name}`, name, linked, cms: [cm], variantCount: 3 });

const full = [g("4", "110cm"), g("6", "120cm"), g("8", "130cm"), g("10", "140cm"), g("12", "150cm"), g("14", "160cm")];

test("full kids product: every value shifts down, ascending so each target is free", () => {
  const d = decideRenames(full, gid);
  assert.ok(d.ok);
  if (!d.ok) return;
  assert.deepEqual(d.ops.map((o) => `${o.fromName}>${o.toName}`), ["4>2", "6>4", "8>6", "10>8", "12>10", "14>12"]);
  assert.deepEqual(d.ops.map((o) => o.toLinked), ["g2", "g4", "g6", "g8", "g10", "g12"]);
});

test("a product without 110cm only shifts what it has (no collision)", () => {
  const d = decideRenames(full.slice(2), gid);
  assert.ok(d.ok);
  if (d.ok) assert.deepEqual(d.ops.map((o) => `${o.fromName}>${o.toName}`), ["8>6", "10>8", "12>10", "14>12"]);
});

test("a single-size kids product (bib at 140cm): 10 -> 8", () => {
  const d = decideRenames([g("10", "140cm")], gid);
  assert.ok(d.ok);
  if (d.ok) assert.deepEqual(d.ops.map((o) => `${o.fromName}>${o.toName}`), ["10>8"]);
});

test("already relabeled values are left alone (idempotent re-run)", () => {
  const d = decideRenames([g("2", "110cm"), g("4", "120cm"), g("6", "130cm")], gid);
  assert.ok(d.ok);
  if (d.ok) assert.deepEqual([d.ops.length, d.alreadyDone], [0, 3]);
});

test("a half-done product (mixed old/new) still resolves per value, but a real collision stops", () => {
  // 120cm already "4", 130cm still "8": fine. 110cm still "4" AND 120cm already "4" cannot both exist, but guard anyway:
  const d = decideRenames([g("4", "110cm"), g("4", "120cm")].map((x, i) => ({ ...x, valueId: `v${i}` })), gid);
  assert.ok(d.ok === false || d.ops.every((o) => o.toName !== "4"));
});

test("stops on mixed heights under one value, unmapped heights, unexpected labels, and a missing size GID", () => {
  assert.equal(decideRenames([{ ...g("6", "120cm"), cms: ["120cm", "130cm"] }], gid).ok, false);
  assert.equal(decideRenames([g("16", "170cm")], gid).ok, false);
  assert.equal(decideRenames([g("9", "120cm")], gid).ok, false);
  const noGid = decideRenames([g("6", "120cm")], () => null);
  assert.equal(noGid.ok, false);
  if (!noGid.ok) assert.match(noGid.problems[0], /seed/);
});

test("mutation payload: default carries name + link, fallback is link-only", () => {
  const op = { valueId: "v6", toName: "4", toLinked: "g4" };
  assert.deepEqual(valueInput(op, "name+link"), { id: "v6", name: "4", linkedMetafieldValue: "g4" });
  assert.deepEqual(valueInput(op, "link-only"), { id: "v6", linkedMetafieldValue: "g4" });
});

// ---------------------------------------------------------------- resume / state

import { classifyState, planProblems, bulkSetVariantSizes, DB_TX_OPTIONS, type StylePlan } from "../lib/size-relabel";

function plan(o: { values: number; opsLeft: number; done: number; skus: number; dbPending: number; dbRows: number }): StylePlan {
  const variants = Array.from({ length: o.values * 12 }, (_, i) => ({ id: `v${i}`, sku: "", qty: 0, color: null, size: null, inventoryItemId: null, weightLb: 1, requiresShipping: true, price: "1.00" }));
  return {
    styleCode: "X",
    dbKidsRows: o.dbRows,
    products: [
      {
        snapshot: { productGid: "p", title: "T", status: "ACTIVE", sizeOption: null, variants },
        ops: Array.from({ length: o.opsLeft }, () => ({}) as never),
        alreadyDone: o.done,
        expected: new Map(),
        skuWrites: Array.from({ length: o.skus }, () => ({ id: "v", sku: "s" })),
        problems: [],
      },
    ],
    dbUpdates: Array.from({ length: o.dbPending }, () => ({}) as never),
    problems: [],
  };
}

test("state: everything on new labels = complete", () => {
  assert.equal(classifyState(plan({ values: 6, opsLeft: 0, done: 6, skus: 0, dbPending: 0, dbRows: 72 })).state, "complete");
});

test("state: Shopify done, DB old (the P2028 case) = shopify-only, and it is resumable (no planProblems)", () => {
  const p = plan({ values: 6, opsLeft: 0, done: 6, skus: 0, dbPending: 72, dbRows: 72 });
  assert.equal(classifyState(p).state, "shopify-only");
  assert.deepEqual(planProblems(p), []);
});

test("state: nothing done anywhere = untouched", () => {
  const p = plan({ values: 6, opsLeft: 6, done: 0, skus: 72, dbPending: 72, dbRows: 72 });
  assert.equal(classifyState(p).state, "untouched");
});

test("state: values renamed but SKUs still old, DB old = shopify-partial (resumable)", () => {
  const p = plan({ values: 6, opsLeft: 0, done: 6, skus: 30, dbPending: 72, dbRows: 72 });
  assert.equal(classifyState(p).state, "shopify-partial");
  assert.deepEqual(planProblems(p), []);
});

test("state: DB new but Shopify old = anomaly, execution refuses (never guessed)", () => {
  const p = plan({ values: 6, opsLeft: 6, done: 0, skus: 72, dbPending: 0, dbRows: 72 });
  assert.equal(classifyState(p).state, "anomaly");
  assert.match(planProblems(p)[0], /DB is already on the new labels but Shopify still has old ones/);
});

test("state: Shopify pending and DB only partly changed = anomaly", () => {
  const p = plan({ values: 6, opsLeft: 3, done: 3, skus: 10, dbPending: 30, dbRows: 72 });
  assert.equal(classifyState(p).state, "anomaly");
  assert.ok(planProblems(p).length > 0);
});

// ---------------------------------------------------------------- large-product DB update

function fakeTx(rowsPerStatement: (n: number, sql: string) => number) {
  const calls: { sql: string; n: number }[] = [];
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      const n = calls.length === 0 ? idsLen : rowsLen;
      calls.push({ sql, n });
      return rowsPerStatement(calls.length, sql);
    },
  };
  return { tx: tx as never, calls };
}
let idsLen = 0;
let rowsLen = 0;

test("large product: 130 rows are written in exactly two statements (park on placeholders, then final values)", async () => {
  const rows = Array.from({ length: 130 }, (_, i) => ({ dbId: i + 1, size: String(2 + 2 * (i % 6)), sku: `S-${i}` }));
  idsLen = rowsLen = rows.length;
  const { tx, calls } = fakeTx(() => rows.length);
  await bulkSetVariantSizes(tx, rows);
  assert.equal(calls.length, 2, "constant number of round trips regardless of row count");
  assert.match(calls[0].sql, /relabel-tmp-/);
  assert.match(calls[1].sql, /FROM \(VALUES/);
  assert.ok(calls[0].sql.indexOf("UPDATE") === calls[0].sql.lastIndexOf("UPDATE") && calls[1].sql.includes("v.\"id\" = d.id"));
});

test("large product: a short update count aborts (so the transaction rolls back)", async () => {
  const rows = Array.from({ length: 72 }, (_, i) => ({ dbId: i + 1, size: "4", sku: `S-${i}` }));
  idsLen = rowsLen = rows.length;
  const { tx } = fakeTx((call) => (call === 1 ? rows.length : rows.length - 1));
  await assert.rejects(() => bulkSetVariantSizes(tx, rows), /updated 71 of 72/);
});

test("no rows = no statements; interactive transaction limits are explicit", async () => {
  const { tx, calls } = fakeTx(() => 0);
  await bulkSetVariantSizes(tx, []);
  assert.equal(calls.length, 0);
  assert.deepEqual({ ...DB_TX_OPTIONS }, { timeout: 120000, maxWait: 15000 });
});
