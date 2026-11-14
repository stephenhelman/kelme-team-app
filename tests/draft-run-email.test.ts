import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPending } from "../lib/draft-run";
import { draftAdminUrl, draftEmailSubject, renderNewDraftsEmail, type DraftEmailItem } from "../lib/draft-email";

const fav = (no: string) => ({ id: Number(no.replace(/\D/g, "")) || 1, no, note: no });
const ctx = (on: string[], jobs: Record<string, string> = {}) => ({ onShopify: (c: string) => on.includes(c), jobStatus: new Map(Object.entries(jobs)) });

test("selection: skips anything on Shopify or already created, never re-creates CREATING/FAILED, re-evaluates BLOCKED", () => {
  const favs = ["A1", "B2", "C3", "D4", "E5", "F6"].map(fav);
  const s = selectPending(favs, ctx(["A1"], { B2: "CREATED", C3: "FAILED", D4: "CREATING", E5: "BLOCKED" }));
  assert.deepEqual(s.pending.map((f) => f.no), ["E5", "F6"]);
  assert.deepEqual(s.needsHuman, [{ styleCode: "C3", status: "FAILED" }, { styleCode: "D4", status: "CREATING" }]);
  assert.equal(s.alreadyOnShopify, 2);
});

test("selection: the cap creates up to N in a stable order and reports the rest as over cap", () => {
  const favs = Array.from({ length: 20 }, (_, i) => fav(`S${String(i).padStart(2, "0")}`)).reverse();
  const s = selectPending(favs, ctx([]), 15);
  assert.equal(s.pending.length, 15);
  assert.equal(s.overCap.length, 5);
  assert.equal(s.pending[0].no, "S00"); // deterministic: sorted by style code
  assert.equal(s.overCap[0].no, "S15");
});

test("selection: an un-favorited product simply is not in the list (nothing to do)", () => {
  assert.equal(selectPending([], ctx([])).pending.length, 0);
});

const item = (over: Partial<DraftEmailItem> = {}): DraftEmailItem => ({
  title: "KELME Soccer Jersey - Adults - 7451ZB1795", styleCode: "7451ZB1795", shopifyProductId: "gid://shopify/Product/8701060841668",
  colors: ["White", "Red/Black"], sizes: ["S", "M", "L"], sizesNotOffered: ["4XL", "5XL"], todos: ["needs-price", "needs-images"], ...over,
});

test("email: subject, what-to-do steps, one table per draft with badges, not-offered sizes and an admin link", () => {
  const m = renderNewDraftsEmail([item(), item({ styleCode: "X2", shopifyProductId: "gid://shopify/Product/2", todos: ["needs-price", "needs-category", "needs-review"], sizesNotOffered: [] })], "https://shop.myshopify.com/admin/");
  assert.equal(m.subject, "2 new products are ready for you to price");
  assert.equal(draftEmailSubject(1), "1 new product is ready for you to price");
  for (const word of ["Set the price", "description", "images", "Publish"]) assert.match(m.html, new RegExp(word));
  assert.equal((m.html.match(/<table role="presentation"/g) ?? []).length, 2);
  for (const badge of ["Needs price", "Needs images", "Needs category", "Check audience"]) assert.match(m.html, new RegExp(badge));
  assert.match(m.html, /4XL, 5XL/);
  assert.match(m.html, /https:\/\/shop\.myshopify\.com\/admin\/products\/8701060841668/);
  assert.equal(draftAdminUrl("https://x/admin/", "gid://shopify/Product/9"), "https://x/admin/products/9");
  assert.match(m.text, /Style code: 7451ZB1795/);
});

test("email: phone friendly (single narrow column, no wide table) and escapes names", () => {
  const m = renderNewDraftsEmail([item({ title: "A <b> & C" })], "https://x/admin");
  assert.match(m.html, /max-width:600px/);
  assert.match(m.html, /A &lt;b&gt; &amp; C/);
});

import { alertsFor, autoConfigFromEnv, dueForRun } from "../lib/auto-drafts";
import type { RunReport } from "../lib/draft-run";

test("auto drafts: off by default, only the exact string 'true' enables it, cap defaults to 15", () => {
  assert.deepEqual(autoConfigFromEnv({}), { enabled: false, cap: 15 });
  assert.equal(autoConfigFromEnv({ AUTO_DRAFTS_ENABLED: "1" }).enabled, false);
  assert.equal(autoConfigFromEnv({ AUTO_DRAFTS_ENABLED: "true" }).enabled, true);
  assert.equal(autoConfigFromEnv({ MAX_DRAFTS_PER_RUN: "5" }).cap, 5);
  assert.equal(autoConfigFromEnv({ MAX_DRAFTS_PER_RUN: "abc" }).cap, 15);
  assert.equal(autoConfigFromEnv({ MAX_DRAFTS_PER_RUN: "0" }).cap, 15);
});

test("auto drafts: one attempt per day, success or failure (no retry loop)", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  assert.equal(dueForRun(null, now), true);
  assert.equal(dueForRun(new Date("2026-11-15T09:00:00Z"), now), false);
  assert.equal(dueForRun(new Date("2026-11-14T10:00:00Z"), now), true);
});

const report = (over: Partial<RunReport> = {}): RunReport => ({ runId: 7, source: "auto", pending: 0, created: [], blocked: [], failed: [], skipped: [], overCap: [], needsHuman: [], stoppedReason: null, missingColors: [], ...over });
const bad = (r: RunReport) => alertsFor(r, 15).filter((a) => a.isBad).map((a) => a.kind);

test("auto drafts alerts: quiet run raises nothing; over-cap, failure, blocked and stuck each raise their own", () => {
  assert.deepEqual(bad(report()), []);
  assert.deepEqual(bad(report({ overCap: ["A", "B"] })), ["auto_drafts_over_cap"]);
  assert.deepEqual(bad(report({ failed: [{ styleCode: "X", status: "failed", message: "boom" }], stoppedReason: "failure on X" })), ["auto_drafts_failure"]);
  assert.deepEqual(bad(report({ blocked: [{ styleCode: "Y", status: "blocked", message: "unknown size" }] })), ["auto_drafts_blocked"]);
  assert.deepEqual(bad(report({ needsHuman: [{ styleCode: "Z", status: "FAILED" }] })), ["auto_drafts_stuck"]);
  const over = alertsFor(report({ overCap: ["A", "B"] }), 15).find((a) => a.kind === "auto_drafts_over_cap")!;
  assert.match(over.subject!, /2 more favorite\(s\) waiting \(cap 15 per run\)/);
});
