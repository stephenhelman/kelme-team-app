/**
 * One-time (or manually re-run) seed: pulls the vendor's favorited catalog
 * (endpoint A) plus each product's stock via the sku-sheet (endpoint C) and
 * upserts into the DB. Run with a fresh KELME_TOKEN in .env:
 *
 *   node --env-file=.env prisma/seed.mjs
 *
 * Merge rule: this script writes ONLY Kelme-owned columns, keyed on pdtid.
 * It never touches sellPrice/discount/isPublished. A favorite missing from
 * this run is marked active=false, never hard-deleted.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const B2B_URL =
  process.env.KELME_B2B_URL ??
  "http://gkemb2b.kelmechina.com:5020/svr/portal/servlets/binserv/B2B";
const ORIGIN = process.env.KELME_ORIGIN ?? "http://gkemb2b.kelmechina.com:5020";
const TOKEN = process.env.KELME_TOKEN;
const PAGE_SIZE = 60;
const HEADQUARTERS_LABEL = "Headquarters Inventory";
const FOB_FORMULA_PATTERN = /amt\(([\d.]+),/;
const IMAGE_BASE = "http://gkemb2b.kelmechina.com:5020/kelmeb2bhw/product/normal";

// Kids gear is sized by height in cm ("110", "120"...) rather than
// letter sizes — label it "110cm" so shoppers don't mistake it for a code.
// Letter sizes (S, M, 2XL...) pass through untouched.
function formatSizeLabel(label) {
  return /^\d+$/.test(label) ? `${label}cm` : label;
}

if (!TOKEN) {
  console.error("KELME_TOKEN is not set. Paste a fresh session token into .env and re-run.");
  process.exit(1);
}

async function callB2B(command, params) {
  const transactions = [
    { id: 1, command: "com.agilecontrol.b2bweb.B2BCmd", params: { parentnode: -1, cmd: command, ...params } },
  ];
  const body = new URLSearchParams();
  body.set("transactions", JSON.stringify(transactions));

  const res = await fetch(B2B_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Token: TOKEN,
      Origin: ORIGIN,
      Referer: `${ORIGIN}/portal/`,
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Kelme returned HTTP ${res.status}`);

  const data = await res.json();
  const tx = Array.isArray(data) ? data[0] : data;
  if (tx?.code === "000005") {
    throw new Error("Kelme session expired (code 000005) — paste a fresh token and re-run");
  }
  return tx;
}

async function fetchAllFavorites() {
  const products = [];
  let start = 0;
  let total = Infinity;

  while (start < total) {
    const tx = await callB2B("b2b.pdt.search", { start, pagesize: PAGE_SIZE, isfav: true });
    total = tx?.result?.total ?? 0;
    const page = Array.isArray(tx?.result?.pdt_s) ? tx.result.pdt_s : [];
    products.push(...page);
    if (page.length === 0) break;
    start += page.length;
  }

  return products;
}

function categoryIdsOf(raw) {
  return Object.keys(raw)
    .filter((k) => /^m_dim\d+_id$/.test(k) && raw[k])
    .map((k) => `${k}:${raw[k]}`)
    .join(",");
}

// A spreadsheet grid, cells keyed "row:col". Each color gets 3 rows starting
// at a qtyRow index R: R = "Order Quantity" (ignored), R+1 = "Headquarters
// Inventory" (the stock we want), R+2 = "Pending Inventory" (ignored). Size
// headers live in row 0 at each sizeCol index, newline-separated (KELME size
// first). colorContrast maps the row-0 label ("{styleCode}{ColorName},{code}")
// to the color code. Confirmed against a live b2b.pdt.sheet response.
function parseSkuSheet(raw, styleCode) {
  try {
    const def = raw?.def;
    const config = def?.config;
    const cells = def?.cells;
    if (!config?.sizeCol?.length || !config?.qtyRow?.length || !cells) return [];

    const sizeLabels = new Map();
    for (const col of config.sizeCol) {
      const header = cells[`0:${col}`]?.v ?? "";
      const label = header.split(/\r?\n/)[0]?.trim();
      if (label) sizeLabels.set(col, formatSizeLabel(label));
    }

    const entries = [];

    for (const row of config.qtyRow) {
      const stockRow = row + 1;
      if (!(cells[`${stockRow}:1`]?.v ?? "").includes(HEADQUARTERS_LABEL)) continue;

      const rawLabel = cells[`${row}:0`]?.v ?? "";
      const colorCode = config.colorContrast[rawLabel] ?? "";
      const colorName = rawLabel.startsWith(styleCode)
        ? rawLabel.slice(styleCode.length, rawLabel.lastIndexOf(",")).trim() || rawLabel
        : rawLabel;

      for (const [col, size] of sizeLabels) {
        const qty = Number(cells[`${stockRow}:${col}`]?.v || 0);
        if (!Number.isFinite(qty)) continue;
        entries.push({ color: colorName, colorCode, size, qty });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// The FOB Xiamen unit cost isn't a discrete field — it's a constant baked
// into every "Sum Amt" formula cell (amt(7.3, ...)).
function extractFobCost(raw) {
  const cells = raw?.def?.cells;
  if (!cells) return null;
  for (const cell of Object.values(cells)) {
    if (cell.t !== "f" || !cell.f) continue;
    const match = cell.f.match(FOB_FORMULA_PATTERN);
    if (match) return Number(match[1]);
  }
  return null;
}

// Server-side-only reachability check, run once here at seed time — never
// live on click. Any failure (404, timeout, network error) just means "this
// color has no dedicated photo".
async function checkImageExists(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function buildColorImageMap(styleCode, entries) {
  const colorCodes = [...new Set(entries.map((e) => e.colorCode).filter(Boolean))];
  const results = await Promise.all(
    colorCodes.map(async (colorCode) => {
      const url = `${IMAGE_BASE}/${styleCode}_${colorCode}_01.jpg`;
      const exists = await checkImageExists(url);
      return [colorCode, exists ? url : null];
    }),
  );
  return Object.fromEntries(results);
}

async function fetchSheet(pdtid, styleCode) {
  try {
    const tx = await callB2B("b2b.pdt.sheet", { pdtid });
    const result = tx?.result ?? {};
    const stock = parseSkuSheet(result, styleCode);
    const colorImages = stock.length > 0 ? await buildColorImageMap(styleCode, stock) : null;
    return { stock, colorImages, fobCost: extractFobCost(result) };
  } catch (err) {
    console.warn(`  sku-sheet lookup failed for pdtid ${pdtid}: ${err.message}`);
    return { stock: null, colorImages: null, fobCost: null }; // null stock = leave existing snapshot untouched
  }
}

async function main() {
  console.log("Fetching favorited catalog (endpoint A)...");
  const favorites = await fetchAllFavorites();
  console.log(`Fetched ${favorites.length} favorites.`);

  const seenPdtids = new Set();

  for (const raw of favorites) {
    const pdtid = raw.id;
    seenPdtids.add(pdtid);

    process.stdout.write(`  [${pdtid}] ${raw.note ?? raw.no} — stock…`);
    const { stock, colorImages, fobCost } = await fetchSheet(pdtid, raw.no ?? "");
    const imagesFound = colorImages ? Object.values(colorImages).filter(Boolean).length : 0;
    console.log(
      stock === null
        ? " skipped"
        : ` ${stock.length} rows, FOB ${fobCost ?? "n/a"}, images ${imagesFound}/${Object.keys(colorImages ?? {}).length}`,
    );

    const kelmeFields = {
      styleCode: raw.no ?? "",
      name: raw.note ?? "",
      colors: raw.colors ?? "",
      imageUrl: raw.mainpic ?? "",
      kelmeCatalogPrice: Number(raw.price ?? 0),
      categoryIds: categoryIdsOf(raw),
      active: true,
      ...(stock !== null ? { stock: JSON.stringify(stock), stockSyncedAt: new Date() } : {}),
      ...(colorImages !== null ? { colorImages: JSON.stringify(colorImages) } : {}),
      ...(fobCost != null ? { kelmeFobCost: fobCost } : {}),
    };

    await prisma.product.upsert({
      where: { pdtid },
      update: kelmeFields,
      create: {
        pdtid,
        ...kelmeFields,
        kelmeFobCost: fobCost ?? 0,
        stock: stock !== null ? JSON.stringify(stock) : "[]",
        colorImages: colorImages !== null ? JSON.stringify(colorImages) : "{}",
      },
    });
  }

  const existing = await prisma.product.findMany({ where: { active: true }, select: { pdtid: true } });
  const stale = existing.filter((p) => !seenPdtids.has(p.pdtid)).map((p) => p.pdtid);
  if (stale.length > 0) {
    await prisma.product.updateMany({ where: { pdtid: { in: stale } }, data: { active: false } });
    console.log(`Marked ${stale.length} product(s) inactive (no longer favorited).`);
  }

  await prisma.settings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });

  console.log("Seed complete.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
