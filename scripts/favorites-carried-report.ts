/**
 * READ-ONLY report: every Kelme favorite that is NOT on Shopify, against the sizes we CARRY.
 * Reads Kelme live, Shopify titles and the DB (reads only). Writes ONLY the two report files.
 * No DB writes, no re-capture, no store writes.
 *
 * Carried: kids 2/4/6/8/10/12 (110-160cm), adult XXS-3XL, One Size, balls.
 * Everything else is "left off" at creation. A product is blocked only if it has ZERO
 * declared variants in a carried size (a carried size with qty 0 is made-to-order and still creatable).
 *
 *   npx tsx --env-file=.env scripts/favorites-carried-report.ts
 */
import { writeFileSync } from "node:fs";
import { fetchFavoritesPage, fetchProductAttributes, fetchProductDetail, fetchSkuSheet } from "@/lib/kelme";
import { parseSkuSheet } from "@/lib/stock";
import { buildColorImageMap, isBallProduct } from "@/lib/kelme-capture";
import { mapAttributes } from "@/lib/kelme-attributes";
import { classifySize, sellableApparelLabels, ONE_SIZE_LABEL } from "@/lib/size-config";
import { categoryFor } from "@/lib/shopify-draft-plan";
import { classifyAudience } from "@/lib/shopify-tags";
import { fetchShopifyTitles } from "@/lib/draft-preflight";
import { titleHasStyleCode } from "@/lib/style-match";
import { prisma } from "@/lib/prisma";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (String(e).includes("session expired")) throw e;
    await sleep(800);
    return await fn();
  }
}

interface Cell {
  color: string;
  colorName: string;
  raw: string;
  label: string;
  qty: number;
}
interface Row {
  styleCode: string;
  name: string;
  audience: string;
  category: string;
  colors: string[];
  carried: Cell[];
  leftOff: Cell[]; // policy-excluded sizes (8XL+, 4XL-7XL, kids 100/170cm)
  unknown: Cell[]; // labels on no chart
  notes: string[];
  carriedUnits: number;
  rawLabels: string[];
}

async function main() {
  // 1. Favorites, live from Kelme.
  const favs: Awaited<ReturnType<typeof fetchFavoritesPage>>["products"] = [];
  for (let start = 0; ; start += 60) {
    const page = await retry(() => fetchFavoritesPage(start, 60));
    favs.push(...page.products);
    if (start + 60 >= page.total || page.products.length === 0) break;
    await sleep(400);
  }
  console.log(`favorites on Kelme: ${favs.length}`);

  // 2. Already on Shopify (any status, incl. UNLISTED): by title, plus the DB flag.
  const titles = await fetchShopifyTitles();
  const dbOn = new Set((await prisma.product.findMany({ where: { onShopify: true }, select: { styleCode: true } })).map((p) => p.styleCode));
  const onShopify = (code: string) => dbOn.has(code) || titles.some((t) => titleHasStyleCode(t.title, code));
  const todo = favs.filter((f) => !onShopify(f.no));
  console.log(`already on Shopify (any status): ${favs.length - todo.length}; not on Shopify: ${todo.length}`);

  const sellable = new Set([...sellableApparelLabels(), ONE_SIZE_LABEL]);
  const rows: Row[] = [];
  const errors: string[] = [];
  for (let i = 0; i < todo.length; i++) {
    const f = todo[i];
    try {
      const sheet = await retry(() => fetchSkuSheet(f.id));
      await sleep(350);
      const attrs = await retry(() => fetchProductAttributes(f.id));
      await sleep(350);
      const detail = await retry(() => fetchProductDetail(f.id));
      await sleep(350);
      const { entries } = parseSkuSheet(sheet, f.no);
      const a = mapAttributes(attrs);
      const isBall = isBallProduct(f.note ?? "");
      const row: Row = {
        styleCode: f.no,
        name: f.note ?? "",
        audience: classifyAudience(f.note ?? "", a.gender, a.subCategory),
        category: categoryFor(a.subCategory)?.label ?? `(none for "${a.subCategory ?? ""}")`,
        colors: [],
        carried: [],
        leftOff: [],
        unknown: [],
        notes: [],
        carriedUnits: 0,
        rawLabels: [],
      };
      const seen = new Set<string>();
      for (const e of entries) {
        if (!e.colorCode) continue;
        if (!row.rawLabels.includes(e.kelmeSize)) row.rawLabels.push(e.kelmeSize);
        const c = classifySize(e.kelmeSize, isBall);
        const key = `${e.colorCode}::${e.kelmeSize}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cell: Cell = { color: e.colorCode, colorName: e.colorName, raw: e.kelmeSize, label: c.status === "ok" ? c.shopifySize : c.kelmeSize, qty: e.qty };
        if (c.status === "excluded") row.leftOff.push(cell);
        else if (c.status === "unknown") row.unknown.push(cell);
        else if (isBall || sellable.has(c.shopifySize)) row.carried.push(cell);
        else row.unknown.push(cell); // maps through but is not a label we carry — left off, reported separately
      }
      row.colors = [...new Set(entries.map((e) => e.colorCode).filter(Boolean))];
      row.carriedUnits = row.carried.reduce((n, c) => n + c.qty, 0);
      const imgs = buildColorImageMap(detail.allpic, f.no, new Set(row.colors));
      const noImg = [...new Set(row.carried.map((c) => c.color))].filter((c) => !imgs.has(c));
      if (noImg.length) row.notes.push(`no image for color(s): ${noImg.join(",")}`);
      if (row.category.startsWith("(none")) row.notes.push(`no category match ${row.category}`);
      if (row.audience === "ambiguous") row.notes.push("audience ambiguous");
      rows.push(row);
    } catch (e) {
      errors.push(`${f.no}: ${String(e)}`);
      if (String(e).includes("session expired")) break;
    }
    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${todo.length}`);
  }

  const creatable = rows.filter((r) => r.carried.length > 0).sort((a, b) => b.carriedUnits - a.carriedUnits);
  const blocked = rows.filter((r) => r.carried.length === 0);
  const leftAll = rows.flatMap((r) => [...r.leftOff, ...r.unknown]);
  const leftBySize = new Map<string, { variants: number; units: number }>();
  for (const c of leftAll) {
    const x = leftBySize.get(c.label) ?? { variants: 0, units: 0 };
    x.variants++;
    x.units += c.qty;
    leftBySize.set(c.label, x);
  }
  const fmt = (cells: Cell[]) => {
    const byColor = new Map<string, Cell[]>();
    for (const c of cells) byColor.set(c.color, [...(byColor.get(c.color) ?? []), c]);
    return [...byColor].map(([col, cs]) => `${col} ${cs[0].colorName}: ${cs.map((c) => `${c.label}=${c.qty}${c.qty === 0 ? "*" : ""}`).join(" ")}`).join(" | ");
  };

  const L: string[] = [];
  L.push("# Favorites NOT on Shopify vs carried sizes (read-only)", "", `Generated ${new Date().toISOString()} from live Kelme. Nothing was written to the DB or Shopify.`, "");
  L.push("Carried: kids 2/4/6/8/10/12, adult XXS–3XL, One Size, balls. Everything else is left off. Blocked only if zero carried variants. `*` = qty 0 (made-to-order, still created).", "");
  L.push("## Summary");
  L.push(`- Kelme favorites: ${favs.length}; already on Shopify (any status incl. UNLISTED): ${favs.length - todo.length}; **not on Shopify: ${todo.length}**${errors.length ? ` (${errors.length} read errors, listed at the end)` : ""}`);
  L.push(`- Creatable (≥1 carried variant): **${creatable.length}**; blocked (zero carried): **${blocked.length}**`);
  L.push(`- Variants that would be created: **${creatable.reduce((n, r) => n + r.carried.length, 0)}** (${creatable.reduce((n, r) => n + r.carried.filter((c) => c.qty === 0).length, 0)} at qty 0); carried Kelme units: ${creatable.reduce((n, r) => n + r.carriedUnits, 0)}`);
  L.push(`- Variants left off: **${leftAll.length}** (${leftAll.reduce((n, c) => n + c.qty, 0)} units) — by size: ${[...leftBySize].sort((a, b) => b[1].variants - a[1].variants).map(([s, v]) => `${s}: ${v.variants} (${v.units} u)`).join(", ") || "none"}`);
  L.push(`- Creatable products with a non-size note (info only): ${creatable.filter((r) => r.notes.length).length}`, "");
  L.push("## Creatable (sorted by carried Kelme units)", "");
  for (const r of creatable) {
    L.push(`### ${r.styleCode} — ${r.name}`, `- ${r.audience} · ${r.category} · colors: ${r.colors.join(", ")}`);
    L.push(`- carried (${r.carried.length} variants to create, ${r.carriedUnits} units): ${fmt(r.carried)}`);
    const lo = [...r.leftOff, ...r.unknown];
    if (lo.length) L.push(`- left off (${lo.length}): ${fmt(lo)}${r.unknown.length ? "  ← includes labels that are on no chart" : ""}`);
    if (r.notes.length) L.push(`- note (not a blocker): ${r.notes.join("; ")}`);
    L.push("");
  }
  L.push("## Blocked (zero carried sizes)", "");
  if (blocked.length === 0) L.push("none");
  for (const r of blocked) L.push(`- ${r.styleCode} — ${r.name} · raw Kelme labels: ${r.rawLabels.join(", ") || "(no sheet entries)"}`);
  if (errors.length) L.push("", "## Read errors", ...errors.map((e) => `- ${e}`));
  writeFileSync("favorites-carried-report.md", L.join("\n") + "\n");

  const csv = ["styleCode,name,audience,category,color,colorName,rawSize,label,qty,status,madeToOrder,notes"];
  const q = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  for (const r of rows) {
    for (const [status, cells] of [["carried", r.carried], ["left-off", r.leftOff], ["left-off-unrecognised", r.unknown]] as const) {
      for (const c of cells) {
        csv.push([r.styleCode, q(r.name), r.audience, q(r.category), c.color, q(c.colorName), q(c.raw), c.label, c.qty, r.carried.length ? status : `blocked/${status}`, status === "carried" && c.qty === 0 ? "yes" : "", q(r.notes.join("; "))].join(","));
      }
    }
  }
  writeFileSync("favorites-carried-report.csv", csv.join("\n") + "\n");
  console.log(L.slice(0, 14).join("\n"));
  console.log("\nWritten: favorites-carried-report.md, favorites-carried-report.csv");
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
