import { INVENTORY_PAGE_RANGE, INVENTORY_SOURCE_URL } from "./config";
import { getAvailability, type AvailabilityLevel } from "./availability";
import type { InventoryResponse, InventoryRow, Product } from "./types";

/**
 * Server-side inventory cache.
 *
 * The POC only exposes Kelme's start/range offset paging (no per-style
 * query), so there is no way to ask the source for "just style X". Instead
 * we walk the feed in small pages, merging rows into an in-memory product
 * map that persists for the life of the server process. Callers ask for a
 * page of products (or a single style); the cache pulls just enough
 * additional Kelme pages to satisfy that ask and stops — it never requests
 * the full ~165k rows in one shot.
 */

let cursor = 0;
let totalRowCount: number | null = null;
let exhausted = false;
const products = new Map<string, Product>();

// Serializes concurrent callers onto one fetch chain so parallel requests
// don't race the shared cursor/cache.
let fetchChain: Promise<void> = Promise.resolve();

// Safety caps so a single request (e.g. a rare filter, or an unknown style)
// can't spiral into scanning the whole feed in one go.
const ROWS_PER_SCAN_BURST = INVENTORY_PAGE_RANGE * 3;
const MAX_SCAN_BURSTS_PER_CALL = 20;

function mergeRow(row: InventoryRow) {
  let product = products.get(row.style);
  if (!product) {
    product = { style: row.style, colors: [], variants: [], totalQty: 0 };
    products.set(row.style, product);
  }

  if (!product.colors.some((c) => c.colorCode === row.colorCode)) {
    product.colors.push({ color: row.color, colorCode: row.colorCode });
  }

  let variant = product.variants.find(
    (v) => v.colorCode === row.colorCode && v.size === row.size,
  );
  if (!variant) {
    variant = {
      color: row.color,
      colorCode: row.colorCode,
      size: row.size,
      qty: 0,
      warehouses: [],
    };
    product.variants.push(variant);
  }

  variant.qty += row.qty;
  product.totalQty += row.qty;

  const warehouse = variant.warehouses.find((w) => w.warehouse === row.warehouse);
  if (warehouse) {
    warehouse.qty += row.qty;
  } else {
    variant.warehouses.push({ warehouse: row.warehouse, qty: row.qty });
  }
}

async function fetchPage(start: number, range: number): Promise<InventoryResponse> {
  const url = new URL(INVENTORY_SOURCE_URL);
  url.searchParams.set("start", String(start));
  url.searchParams.set("range", String(range));

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Inventory source returned ${res.status}`);
  }
  return res.json();
}

async function advanceOneBurst() {
  if (exhausted) return;

  const data = await fetchPage(cursor, INVENTORY_PAGE_RANGE);
  totalRowCount = data.count ?? totalRowCount;
  data.rows.forEach(mergeRow);
  cursor += data.range || INVENTORY_PAGE_RANGE;

  if (data.rows.length === 0 || (totalRowCount != null && cursor >= totalRowCount)) {
    exhausted = true;
  }
}

function scanBurst(): Promise<void> {
  fetchChain = fetchChain.then(() => advanceOneBurst());
  return fetchChain;
}

export interface CatalogFilters {
  search?: string;
  color?: string;
  availability?: AvailabilityLevel;
}

export interface CatalogPage {
  products: Product[];
  hasMore: boolean;
  totalRowCount: number | null;
}

function matchesFilters(product: Product, filters: CatalogFilters): boolean {
  if (filters.search) {
    const q = filters.search.trim().toLowerCase();
    if (q && !product.style.toLowerCase().includes(q)) return false;
  }
  if (filters.color) {
    const q = filters.color.trim().toLowerCase();
    if (q && !product.colors.some((c) => c.color.toLowerCase().includes(q))) {
      return false;
    }
  }
  if (filters.availability) {
    if (!product.variants.some((v) => getAvailability(v.qty).level === filters.availability)) {
      return false;
    }
  }
  return true;
}

function sortedProducts(): Product[] {
  return [...products.values()].sort((a, b) => a.style.localeCompare(b.style));
}

export async function getCatalogPage(
  page: number,
  pageSize: number,
  filters: CatalogFilters = {},
): Promise<CatalogPage> {
  const target = (page + 1) * pageSize;
  let filtered = sortedProducts().filter((p) => matchesFilters(p, filters));
  let bursts = 0;

  while (filtered.length < target + 1 && !exhausted && bursts < MAX_SCAN_BURSTS_PER_CALL) {
    await scanBurst();
    filtered = sortedProducts().filter((p) => matchesFilters(p, filters));
    bursts += 1;
  }

  const start = page * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  return {
    products: slice,
    hasMore: filtered.length > start + pageSize || !exhausted,
    totalRowCount,
  };
}

export async function getProductByStyle(style: string): Promise<Product | null> {
  let bursts = 0;
  while (!products.has(style) && !exhausted && bursts < MAX_SCAN_BURSTS_PER_CALL) {
    await scanBurst();
    bursts += 1;
  }
  return products.get(style) ?? null;
}
