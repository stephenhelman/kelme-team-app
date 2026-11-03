import { test } from "node:test";
import assert from "node:assert/strict";
import { auditOrder } from "../lib/order-audit";
import { buildCsv, buildHtml, buildSubject, CSV_HEADER } from "../lib/order-sheet";
import * as fx from "./fixtures";

/** Minimal RFC-4180 parser so the test checks real cell boundaries. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\r") { /* skip */ }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  return rows;
}

const col = (name: (typeof CSV_HEADER)[number]) => CSV_HEADER.indexOf(name);

test("CSV: header + one row per unit across non-fee lines (25 jerseys + 2 balls)", () => {
  const rows = parseCsv(buildCsv(fx.order1028, auditOrder(fx.order1028, fx.tags), fx.variantInfo));
  assert.deepEqual(rows[0], [...CSV_HEADER]);
  assert.equal(rows.length - 1, 27);
  assert.ok(rows.slice(1).every((r) => r.length === CSV_HEADER.length));
});

test("CSV: roster rows carry number, name, size, SKU, style, logo fields; sorted by size then number", () => {
  const rows = parseCsv(buildCsv(fx.order1028, auditOrder(fx.order1028, fx.tags), fx.variantInfo)).slice(1);
  const jerseys = rows.filter((r) => r[col("Product")] === "Kelme Match Jersey");
  assert.equal(jerseys.length, 25);
  assert.deepEqual(jerseys[0].slice(0, 9), ["#1028", "Kelme Match Jersey", "9001", "Black", "M", "9001-110-M", "1", "Alvarez", "Heat Transfer"]);
  assert.equal(jerseys[0][col("Logo Placement")], "Both");
  assert.equal(jerseys[0][col("Number Placement")], "Both");
  assert.equal(jerseys[0][col("Print Color")], "Black");
  assert.match(jerseys[0][col("Logo URL")], /^https:\/\/cdn\.shopify\.com\/.*\/uploads\//);
  assert.equal(jerseys[14][col("Size")], "L"); // M block (1-14) then L (15-25)
  assert.equal(jerseys[14][col("Number")], "15");
});

test("CSV: non-customized units are blank-roster rows with variant info from the DB map", () => {
  const rows = parseCsv(buildCsv(fx.order1028, auditOrder(fx.order1028, fx.tags), fx.variantInfo)).slice(1);
  const balls = rows.filter((r) => r[col("Product")] === "Kelme Training Ball");
  assert.equal(balls.length, 2);
  assert.deepEqual([balls[0][col("Style Code")], balls[0][col("Color")], balls[0][col("Size")], balls[0][col("Number")], balls[0][col("Logo Application")]], ["7710", "White", "4", "", ""]);
});

test("CSV: roster shorter than quantity is padded to one row per unit", () => {
  const order = structuredClone(fx.order1028);
  const p = order.line_items[0].properties.find((x) => x.name === "_roster")!;
  p.value = JSON.stringify(JSON.parse(p.value).slice(0, 10));
  const rows = parseCsv(buildCsv(order, auditOrder(order, fx.tags), fx.variantInfo)).slice(1);
  assert.equal(rows.filter((r) => r[col("SKU")] === "9001-110-M").length, 14);
});

test("CSV: quotes commas/quotes and neutralises formula injection in names", () => {
  const order = structuredClone(fx.order1028);
  const p = order.line_items[0].properties.find((x) => x.name === "_roster")!;
  const roster = JSON.parse(p.value);
  roster[0].name = '=HYPERLINK("http://x","hi"), Jr';
  roster[1].name = "+cmd";
  p.value = JSON.stringify(roster);
  const rows = parseCsv(buildCsv(order, auditOrder(order, fx.tags), fx.variantInfo)).slice(1);
  const names = rows.filter((r) => r[col("SKU")] === "9001-110-M").map((r) => r[col("Name")]);
  assert.ok(names.includes(`'=HYPERLINK("http://x","hi"), Jr`));
  assert.ok(names.includes("'+cmd"));
});

test("CSV: plain order still produces a sheet (30 unit rows, blank customization)", () => {
  const rows = parseCsv(buildCsv(fx.orderPlain, auditOrder(fx.orderPlain, fx.tags), fx.variantInfo)).slice(1);
  assert.equal(rows.length, 30);
  assert.ok(rows.every((r) => r[col("Number")] === "" && r[col("Name")] === ""));
});

test("subject: count, singular/plural, zero, and CHECK prefix", () => {
  assert.equal(buildSubject(fx.order1028, auditOrder(fx.order1028, fx.tags)), "Order #1028 — 2 customized lines");
  assert.equal(buildSubject(fx.orderUnder25, auditOrder(fx.orderUnder25, fx.tags)), "⚠ CHECK Order #1031 — 1 customized line");
  assert.equal(buildSubject(fx.orderPlain, auditOrder(fx.orderPlain, fx.tags)), "Order #1033 — no customized lines");
});

test("HTML: escapes customer-typed text and refuses to link/embed an unverified logo URL", () => {
  const order = structuredClone(fx.order1028);
  const p = order.line_items[0].properties.find((x) => x.name === "_roster")!;
  const roster = JSON.parse(p.value);
  roster[0].name = '<script>alert(1)</script>';
  p.value = JSON.stringify(roster);
  order.line_items[1].properties.find((x) => x.name === "Logo")!.value = "https://evil.example.com/uploads/x.png";
  const html = buildHtml(order, auditOrder(order, fx.tags), fx.variantInfo);
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes('href="https://evil.example.com'));
  assert.ok(!html.includes('src="https://evil.example.com'));
});

test("HTML: warnings appear before the product blocks; core-only item count in header", () => {
  const html = buildHtml(fx.orderHeatShort, auditOrder(fx.orderHeatShort, fx.tags), fx.variantInfo);
  const warn = html.indexOf("Please check before producing");
  assert.ok(warn > -1 && warn < html.indexOf("Kelme Match Jersey"));
  assert.match(html, /27 items/);
  assert.ok(!html.includes("Heat Transfer Product")); // fee lines summarized, not listed as products
});
