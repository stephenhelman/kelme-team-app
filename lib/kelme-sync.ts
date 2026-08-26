import { prisma } from "./prisma";
import { fetchFavoritesPage, fetchSkuSheet, isKelmeTokenConfigured, type RawFavoriteProduct } from "./kelme";
import { buildColorImageMap, extractFobCost, parseSkuSheet } from "./stock";

const PAGE_SIZE = 60;

function categoryIdsOf(raw: RawFavoriteProduct): string {
  return Object.keys(raw)
    .filter((k) => /^m_dim\d+_id$/.test(k) && raw[k as keyof RawFavoriteProduct])
    .map((k) => `${k}:${raw[k as keyof RawFavoriteProduct]}`)
    .join(",");
}

async function fetchAllFavorites(): Promise<RawFavoriteProduct[]> {
  const products: RawFavoriteProduct[] = [];
  let start = 0;
  let total = Infinity;

  while (start < total) {
    const page = await fetchFavoritesPage(start, PAGE_SIZE);
    total = page.total;
    products.push(...page.products);
    if (page.products.length === 0) break;
    start += page.products.length;
  }

  return products;
}

export interface SyncResult {
  fetched: number;
  stockUpdated: number;
  markedInactive: number;
}

/**
 * The in-app "Refresh from Kelme" action (manual, admin-triggered — not a
 * cron). Same merge rule as the seed script: writes only Kelme-owned
 * columns, keyed on pdtid, and never touches sellPrice/discount/isPublished.
 */
export async function syncFromKelme(): Promise<SyncResult> {
  if (!isKelmeTokenConfigured()) {
    throw new Error("KELME_TOKEN is not set — paste a fresh session token into .env");
  }

  const favorites = await fetchAllFavorites();
  const seenPdtids = new Set<number>();
  let stockUpdated = 0;

  for (const raw of favorites) {
    const pdtid = raw.id;
    seenPdtids.add(pdtid);

    let stockPatch: { stock: string; stockSyncedAt: Date; colorImages: string } | Record<string, never> = {};
    let fobCost: number | null = null;
    try {
      const sheet = await fetchSkuSheet(pdtid);
      const entries = parseSkuSheet(sheet, raw.no ?? "");
      if (entries.length > 0) {
        const colorImages = await buildColorImageMap(raw.no ?? "", entries);
        stockPatch = {
          stock: JSON.stringify(entries),
          stockSyncedAt: new Date(),
          colorImages: JSON.stringify(colorImages),
        };
        stockUpdated += 1;
      }
      fobCost = extractFobCost(sheet);
    } catch {
      // Leave the existing stock snapshot (and FOB cost) untouched.
    }

    const kelmeFields = {
      styleCode: raw.no ?? "",
      name: raw.note ?? "",
      colors: raw.colors ?? "",
      imageUrl: raw.mainpic ?? "",
      kelmeCatalogPrice: Number(raw.price ?? 0),
      categoryIds: categoryIdsOf(raw),
      active: true,
      ...stockPatch,
      ...(fobCost != null ? { kelmeFobCost: fobCost } : {}),
    };

    await prisma.product.upsert({
      where: { pdtid },
      update: kelmeFields,
      create: {
        pdtid,
        ...kelmeFields,
        kelmeFobCost: fobCost ?? 0,
        stock: "stock" in stockPatch ? stockPatch.stock : "[]",
        colorImages: "colorImages" in stockPatch ? stockPatch.colorImages : "{}",
      },
    });
  }

  const existing = await prisma.product.findMany({ where: { active: true }, select: { pdtid: true } });
  const stale = existing.filter((p) => !seenPdtids.has(p.pdtid)).map((p) => p.pdtid);
  if (stale.length > 0) {
    await prisma.product.updateMany({ where: { pdtid: { in: stale } }, data: { active: false } });
  }

  return { fetched: favorites.length, stockUpdated, markedInactive: stale.length };
}
