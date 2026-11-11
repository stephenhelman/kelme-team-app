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
