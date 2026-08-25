import { CATALOG_SOURCE_PAGE_SIZE, CATALOG_SOURCE_URL } from "./config";
import type { CatalogProduct } from "./types";

/**
 * The vendor's favorited product catalog (Sprint 1.5) — ~158 items, unlike
 * the 165k-row inventory feed. Small enough to pull in full (a handful of
 * paged requests against the POC) and cache for the life of the server
 * process, rather than lazily paging on every browse like the raw inventory.
 */

interface RawCatalogProduct {
  no: string;
  note: string;
  price: number;
  discount_price: number;
  colors: string;
  mainpic: string;
  stylename: string;
  id: number;
}

interface CatalogSourcePage {
  code: number | string;
  total: number;
  start: number;
  count: number;
  products: RawCatalogProduct[];
}

let cache: CatalogProduct[] | null = null;
let loadPromise: Promise<CatalogProduct[]> | null = null;

function mapProduct(raw: RawCatalogProduct): CatalogProduct {
  return {
    styleCode: raw.no,
    name: raw.note,
    price: raw.price,
    discountPrice: raw.discount_price,
    colors: (raw.colors ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
    image: raw.mainpic,
    stylename: raw.stylename,
    id: raw.id,
  };
}

async function fetchSourcePage(start: number, pagesize: number): Promise<CatalogSourcePage> {
  const url = new URL(CATALOG_SOURCE_URL);
  url.searchParams.set("start", String(start));
  url.searchParams.set("pagesize", String(pagesize));

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`Catalog source returned ${res.status}`);
  }
  return res.json();
}

async function loadAll(): Promise<CatalogProduct[]> {
  const products: CatalogProduct[] = [];
  let start = 0;
  let total = Infinity;

  while (start < total) {
    const page = await fetchSourcePage(start, CATALOG_SOURCE_PAGE_SIZE);
    total = page.total ?? 0;
    products.push(...page.products.map(mapProduct));
    if (page.products.length === 0) break;
    start += page.products.length;
  }

  return products;
}

export function getAllCatalogProducts(): Promise<CatalogProduct[]> {
  if (cache) return Promise.resolve(cache);
  if (!loadPromise) {
    loadPromise = loadAll().then((products) => {
      cache = products;
      return products;
    });
  }
  return loadPromise;
}

export async function getCatalogProductByStyle(styleCode: string): Promise<CatalogProduct | null> {
  const products = await getAllCatalogProducts();
  return products.find((p) => p.styleCode === styleCode) ?? null;
}

export interface CatalogFilters {
  search?: string;
  color?: string;
}

function matchesFilters(product: CatalogProduct, filters: CatalogFilters): boolean {
  if (filters.search) {
    const q = filters.search.trim().toLowerCase();
    if (
      q &&
      !product.styleCode.toLowerCase().includes(q) &&
      !product.name.toLowerCase().includes(q)
    ) {
      return false;
    }
  }
  if (filters.color) {
    const q = filters.color.trim().toLowerCase();
    if (q && !product.colors.some((c) => c.toLowerCase().includes(q))) return false;
  }
  return true;
}

export interface CatalogPage {
  products: CatalogProduct[];
  hasMore: boolean;
  total: number;
}

export async function getCatalogPage(
  page: number,
  pageSize: number,
  filters: CatalogFilters = {},
): Promise<CatalogPage> {
  const all = await getAllCatalogProducts();
  const filtered = all.filter((p) => matchesFilters(p, filters));
  const start = page * pageSize;
  const slice = filtered.slice(start, start + pageSize);

  return {
    products: slice,
    hasMore: filtered.length > start + pageSize,
    total: filtered.length,
  };
}
