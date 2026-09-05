/**
 * Links Shopify variant identity onto our captured Variant rows. Pulls every
 * Shopify product/variant, matches each variant to a Variant row by exact
 * SKU equality (both sides built with buildSku — see lib/sku.ts), and sets
 * shopifyVariantId + shopifyInventoryItemId on the match.
 *
 * Read-Shopify + write-our-DB only. Never writes to Shopify. Idempotent —
 * re-running re-matches and overwrites the two ID fields, no duplicates.
 */
import { prisma } from "@/lib/prisma";
import { shopifyAdminFetch, parseNextPageUrl } from "@/lib/shopify";

const CALL_PACING_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ShopifyVariant {
  id: number;
  inventory_item_id: number;
  sku: string;
}

interface ShopifyProduct {
  title: string;
  variants: ShopifyVariant[];
}

export interface ShopifyUnmatched {
  sku: string;
  title: string;
}

export interface KelmeUnmatched {
  styleCode: string;
  sku: string;
}

export interface ShopifyLinkReport {
  matchedCount: number;
  shopifyUnmatched: ShopifyUnmatched[];
  kelmeUnmatched: KelmeUnmatched[];
}

interface FlatShopifyVariant {
  sku: string; // trimmed; may be "" for an unstamped variant
  variantId: string;
  inventoryItemId: string;
  title: string;
}

async function fetchAllShopifyVariants(): Promise<FlatShopifyVariant[]> {
  const variants: FlatShopifyVariant[] = [];

  // No status filter — confirmed via /products/count.json that the
  // unfiltered pull already includes active + draft products (status=any
  // is not a valid value here and silently zeroes the result).
  let nextUrl: string | null = "/products.json?limit=250";
  let page = 0;
  let productCount = 0;

  while (nextUrl) {
    const res = await shopifyAdminFetch(nextUrl);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify request failed: HTTP ${res.status} ${body}`);
    }

    const rawBody = await res.text();
    const json = JSON.parse(rawBody) as { products?: ShopifyProduct[] };
    if (!json.products) {
      console.error(`[shopify-link] unexpected response shape on page ${page + 1}: ${rawBody.slice(0, 500)}`);
    }
    const products = json.products ?? [];
    productCount += products.length;
    for (const product of products) {
      for (const variant of product.variants ?? []) {
        variants.push({
          sku: variant.sku?.trim() ?? "",
          variantId: String(variant.id),
          inventoryItemId: String(variant.inventory_item_id),
          title: product.title,
        });
      }
    }

    const linkHeader = res.headers.get("Link");
    nextUrl = parseNextPageUrl(linkHeader);
    page += 1;
    console.log(
      `[shopify-link] fetched page ${page}: ${products.length} products (running total ${productCount} products / ${variants.length} variants), Link header: ${linkHeader ?? "(none)"}`,
    );

    if (nextUrl) await sleep(CALL_PACING_MS);
  }

  console.log(`[shopify-link] pull complete: ${productCount} products / ${variants.length} variants total`);

  return variants;
}

export async function linkShopify(): Promise<ShopifyLinkReport> {
  const shopifyVariants = await fetchAllShopifyVariants();

  const kelmeVariants = await prisma.variant.findMany({
    select: { id: true, sku: true, product: { select: { styleCode: true } } },
  });

  const kelmeBySku = new Map(kelmeVariants.map((v) => [v.sku.trim(), v]));
  const matchedSkus = new Set<string>();

  let matchedCount = 0;
  const shopifyUnmatched: ShopifyUnmatched[] = [];

  for (const shopifyVariant of shopifyVariants) {
    const kelmeVariant = shopifyVariant.sku ? kelmeBySku.get(shopifyVariant.sku) : undefined;
    if (!kelmeVariant) {
      shopifyUnmatched.push({ sku: shopifyVariant.sku, title: shopifyVariant.title });
      continue;
    }

    await prisma.variant.update({
      where: { id: kelmeVariant.id },
      data: {
        shopifyVariantId: shopifyVariant.variantId,
        shopifyInventoryItemId: shopifyVariant.inventoryItemId,
      },
    });
    matchedCount += 1;
    matchedSkus.add(shopifyVariant.sku);
  }

  const kelmeUnmatched: KelmeUnmatched[] = [];
  for (const [sku, kelmeVariant] of kelmeBySku) {
    if (!matchedSkus.has(sku)) {
      kelmeUnmatched.push({ styleCode: kelmeVariant.product.styleCode, sku });
    }
  }

  console.log(
    `[shopify-link] shopifyVariantsSeen=${shopifyVariants.length} matched=${matchedCount} shopifyUnmatched=${shopifyUnmatched.length} kelmeUnmatched=${kelmeUnmatched.length}`,
  );

  return { matchedCount, shopifyUnmatched, kelmeUnmatched };
}
