/**
 * Reconciles the DB's shopifyVariantId/shopifyInventoryItemId against live
 * Shopify — Shopify is treated as the source of truth after the reconcile
 * batch + trims minted new IDs (and, for split style codes, new products
 * entirely). Read-Shopify + write-DB only, never writes Shopify.
 *
 * Match key is identity, NOT sku (sku is null on Shopify right now — the
 * bug fixed in lib/shopify-reconcile.ts's buildMutationInput, not yet
 * backfilled): (styleCode, colorCode, shopifySize). styleCode is derived
 * by testing every DB styleCode against each Shopify product's title using
 * the same whole-word-boundary match used throughout this codebase — a
 * split product's 3 Shopify products all match the same one DB styleCode,
 * which is exactly the fan-out this match key is meant to handle.
 *
 * All variant reads go through GraphQL, paginated per product — REST's
 * /products/{id}.json silently truncates at 100 variants (see
 * lib/shopify-reconcile.ts's fetchOneShopifyProduct comment), so REST is
 * never used here.
 */
import { prisma } from "@/lib/prisma";
import { shopifyGraphQL } from "@/lib/shopify";
import { parseColorCode } from "@/lib/shopify-reconcile";
import { ONE_SIZE } from "@/lib/sku";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function titleContainsStyleCode(title: string, styleCode: string): boolean {
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(styleCode)}([^A-Za-z0-9]|$)`);
  return re.test(title);
}

interface ShopifyProductNode {
  id: string;
  title: string;
  status: string;
  variants: {
    edges: {
      node: {
        id: string;
        inventoryItem: { id: string } | null;
        selectedOptions: { name: string; value: string }[];
      };
    }[];
  };
}

const PRODUCTS_QUERY = `
  query relinkProducts($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          title
          status
          variants(first: 250) {
            edges {
              node {
                id
                inventoryItem { id }
                selectedOptions { name value }
              }
            }
          }
        }
      }
    }
  }
`;

interface ProductsQueryResponse {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: { node: ShopifyProductNode }[];
  };
}

async function fetchAllShopifyProducts(): Promise<ShopifyProductNode[]> {
  const products: ShopifyProductNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  while (hasNextPage) {
    const res: { data?: ProductsQueryResponse; errors?: { message: string }[] } = await shopifyGraphQL<ProductsQueryResponse>(
      PRODUCTS_QUERY,
      { cursor },
    );
    if (res.errors?.length) throw new Error(`products query error: ${JSON.stringify(res.errors)}`);
    const page = res.data!.products;
    products.push(...page.edges.map((e) => e.node));
    hasNextPage = page.pageInfo.hasNextPage;
    cursor = page.pageInfo.endCursor;
  }
  return products;
}

interface FlatShopifyVariant {
  styleCode: string;
  colorCode: string | null;
  size: string | null;
  productId: string;
  productTitle: string;
  variantId: string;
  inventoryItemId: string | null;
}

async function buildShopifyIndex(dbStyleCodes: string[]): Promise<{
  byKey: Map<string, FlatShopifyVariant[]>; // "styleCode::colorCode::size" -> variants (should be 1, flagged if >1)
  ambiguousProducts: { productId: string; title: string; matchedStyleCodes: string[] }[];
  allFlat: FlatShopifyVariant[];
  unlistedProducts: { productId: string; title: string; status: string; styleCode: string }[];
}> {
  const products = await fetchAllShopifyProducts();
  const byKey = new Map<string, FlatShopifyVariant[]>();
  const ambiguousProducts: { productId: string; title: string; matchedStyleCodes: string[] }[] = [];
  const allFlat: FlatShopifyVariant[] = [];
  const unlistedProducts: { productId: string; title: string; status: string; styleCode: string }[] = [];

  for (const product of products) {
    const matches = dbStyleCodes.filter((sc) => titleContainsStyleCode(product.title, sc));
    if (matches.length === 0) continue; // no DB product claims this Shopify product — irrelevant here
    if (matches.length > 1) {
      ambiguousProducts.push({ productId: product.id, title: product.title, matchedStyleCodes: matches });
      continue; // don't guess which styleCode owns it
    }
    const styleCode = matches[0];

    // DRAFT is real catalog mid-build (products get manually drafted while
    // being separated into kids/adults) — still matchable, still gets SKUs
    // written. Only UNLISTED (hidden one-offs like the K16XLQC equipment
    // items) and ARCHIVED (no longer sold) are excluded from matching
    // entirely, so the DB product ends up onShopify:false (never partially
    // true from a stray matched variant) — surfaced via unlistedProducts.
    if (product.status === "UNLISTED" || product.status === "ARCHIVED") {
      unlistedProducts.push({ productId: product.id, title: product.title, status: product.status, styleCode });
      continue;
    }

    for (const { node: v } of product.variants.edges) {
      const colorOpt = v.selectedOptions.find((o) => o.name === "Color");
      // Balls carry their real size (3/4/5) under an option literally named
      // "Ball size", not "Size" — read either name, never add a "Size" option
      // to these products on Shopify (per decision), just read what's there.
      const sizeOpt = v.selectedOptions.find((o) => o.name === "Size" || o.name === "Ball size");
      const colorCode = colorOpt ? parseColorCode(colorOpt.value) : null;
      // Equipment (socks, backpacks, bibs, armbands, agility gear) has no
      // Size or Ball size option on Shopify at all — never add one there
      // (per decision); instead substitute the canonical "One Size" so these
      // variants flow through the same (styleCode, colorCode, size) match key
      // as everything else. lib/sku.ts's ONE_SIZE is the single source of
      // truth for the string.
      const size = sizeOpt ? sizeOpt.value : ONE_SIZE;

      const flat: FlatShopifyVariant = {
        styleCode,
        colorCode,
        size,
        productId: product.id,
        productTitle: product.title,
        variantId: v.id,
        inventoryItemId: v.inventoryItem?.id ?? null,
      };
      allFlat.push(flat);

      if (!colorCode || !size) continue; // unparseable — surfaced via allFlat, not matchable by key
      const key = `${styleCode}::${colorCode}::${size}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(flat);
    }
  }

  return { byKey, ambiguousProducts, allFlat, unlistedProducts };
}

export interface DbUnmatchedEntry {
  variantDbId: number;
  styleCode: string;
  colorCode: string;
  shopifySize: string;
  sku: string;
}

export interface ShopifyUnmatchedEntry {
  productId: string;
  productTitle: string;
  variantId: string;
  colorCode: string | null;
  size: string | null;
  reason: string;
}

export interface SplitProductCheck {
  styleCode: string;
  shopifyProductCount: number;
  shopifyProductTitles: string[];
  dbVariantsDistributed: { productId: string; productTitle: string; count: number }[];
}

export interface UnmatchedStyleCodeEntry {
  styleCode: string;
  dbVariantCount: number;
  onShopify: boolean; // true = REAL link failure (Shopify has this product, but no variant matched)
}

export interface RelinkDryRunResult {
  totalDbVariants: number;
  matchedCount: number;
  ambiguousMatchCount: number;
  dbUnmatched: DbUnmatchedEntry[];
  shopifyUnmatched: ShopifyUnmatchedEntry[];
  ambiguousProducts: { productId: string; title: string; matchedStyleCodes: string[] }[];
  splitProductChecks: SplitProductCheck[];
  unmatchedStyleCodes: UnmatchedStyleCodeEntry[];
  realLinkFailures: UnmatchedStyleCodeEntry[]; // subset of unmatchedStyleCodes where onShopify is true
  unlistedProducts: { productId: string; title: string; status: string; styleCode: string }[]; // matched by title but non-ACTIVE — excluded from matching, forced onShopify:false
  productsOnShopify: number;
  productsFavoritesOnly: number;
  // internal, used by executeRelink — not meant for display
  _matches?: { variantDbId: number; shopifyVariantId: string; shopifyInventoryItemId: string | null }[];
  _productOnShopify?: Map<number, boolean>; // Product.id -> onShopify
}

export async function dryRunRelink(): Promise<RelinkDryRunResult> {
  const dbProducts = await prisma.product.findMany({ select: { id: true, styleCode: true } });
  const dbStyleCodes = [...new Set(dbProducts.map((p) => p.styleCode))];

  const { byKey, ambiguousProducts, allFlat, unlistedProducts } = await buildShopifyIndex(dbStyleCodes);

  // styleCodes whose title matched at least one live Shopify product — used to
  // tell "favorites-only, correctly unmatched" apart from a real link failure.
  const styleCodesSeenOnShopify = new Set(allFlat.map((f) => f.styleCode));

  const dbVariants = await prisma.variant.findMany({
    select: { id: true, colorCode: true, shopifySize: true, sku: true, product: { select: { id: true, styleCode: true } } },
  });

  const dbUnmatched: DbUnmatchedEntry[] = [];
  const matches: { variantDbId: number; shopifyVariantId: string; shopifyInventoryItemId: string | null }[] = [];
  const usedShopifyVariantIds = new Set<string>();
  const productOnShopify = new Map<number, boolean>();
  for (const p of dbProducts) productOnShopify.set(p.id, false);
  let ambiguousMatchCount = 0;

  for (const v of dbVariants) {
    const key = `${v.product.styleCode}::${v.colorCode}::${v.shopifySize}`;
    const candidates = byKey.get(key);
    if (!candidates || candidates.length === 0) {
      dbUnmatched.push({
        variantDbId: v.id,
        styleCode: v.product.styleCode,
        colorCode: v.colorCode,
        shopifySize: v.shopifySize,
        sku: v.sku,
      });
      continue;
    }
    if (candidates.length > 1) {
      ambiguousMatchCount++;
      // still take the first — flagged via count, not silently perfect
    }
    const chosen = candidates[0];
    usedShopifyVariantIds.add(chosen.variantId);
    matches.push({ variantDbId: v.id, shopifyVariantId: chosen.variantId, shopifyInventoryItemId: chosen.inventoryItemId });
    productOnShopify.set(v.product.id, true);
  }

  const shopifyUnmatched: ShopifyUnmatchedEntry[] = [];
  for (const flat of allFlat) {
    if (usedShopifyVariantIds.has(flat.variantId)) continue;
    const reason = !flat.colorCode
      ? "could not parse colorCode from Color option value"
      : !flat.size
        ? "no Size option value"
        : "no matching DB variant for this (styleCode, colorCode, size)";
    shopifyUnmatched.push({
      productId: flat.productId,
      productTitle: flat.productTitle,
      variantId: flat.variantId,
      colorCode: flat.colorCode,
      size: flat.size,
      reason,
    });
  }

  // split-product check: any DB styleCode whose Shopify variants span >1 product
  const splitProductChecks: SplitProductCheck[] = [];
  const styleCodeToProducts = new Map<string, Map<string, { title: string; count: number }>>();
  for (const flat of allFlat) {
    if (!styleCodeToProducts.has(flat.styleCode)) styleCodeToProducts.set(flat.styleCode, new Map());
    const productMap = styleCodeToProducts.get(flat.styleCode)!;
    if (!productMap.has(flat.productId)) productMap.set(flat.productId, { title: flat.productTitle, count: 0 });
    productMap.get(flat.productId)!.count++;
  }
  for (const [styleCode, productMap] of styleCodeToProducts) {
    if (productMap.size <= 1) continue;
    splitProductChecks.push({
      styleCode,
      shopifyProductCount: productMap.size,
      shopifyProductTitles: [...productMap.values()].map((p) => p.title),
      dbVariantsDistributed: [...productMap.entries()].map(([productId, p]) => ({
        productId,
        productTitle: p.title,
        count: p.count,
      })),
    });
  }

  // Cross-reference the 906-style dbUnmatched set by distinct styleCode: is
  // that styleCode's product actually on Shopify (title matched something),
  // even though this specific variant found no key match? If so, it's a
  // real link failure, not an expected favorites-only gap.
  const unmatchedByStyleCode = new Map<string, number>();
  for (const e of dbUnmatched) {
    unmatchedByStyleCode.set(e.styleCode, (unmatchedByStyleCode.get(e.styleCode) ?? 0) + 1);
  }
  const unmatchedStyleCodes: UnmatchedStyleCodeEntry[] = [...unmatchedByStyleCode.entries()]
    .map(([styleCode, dbVariantCount]) => ({
      styleCode,
      dbVariantCount,
      onShopify: styleCodesSeenOnShopify.has(styleCode),
    }))
    .sort((a, b) => b.dbVariantCount - a.dbVariantCount);
  const realLinkFailures = unmatchedStyleCodes.filter((e) => e.onShopify);

  const productsOnShopify = [...productOnShopify.values()].filter(Boolean).length;
  const productsFavoritesOnly = productOnShopify.size - productsOnShopify;

  return {
    totalDbVariants: dbVariants.length,
    matchedCount: matches.length,
    ambiguousMatchCount,
    dbUnmatched,
    shopifyUnmatched,
    ambiguousProducts,
    splitProductChecks,
    unmatchedStyleCodes,
    realLinkFailures,
    unlistedProducts,
    productsOnShopify,
    productsFavoritesOnly,
    _matches: matches,
    _productOnShopify: productOnShopify,
  };
}

export interface RelinkExecuteResult {
  updated: number;
  dbUnmatchedCount: number;
  shopifyUnmatchedCount: number;
  productsSetOnShopifyTrue: number;
  productsSetOnShopifyFalse: number;
}

export async function executeRelink(): Promise<RelinkExecuteResult> {
  const dryRun = await dryRunRelink();
  const matches = dryRun._matches ?? [];
  const productOnShopify = dryRun._productOnShopify ?? new Map<number, boolean>();

  let updated = 0;
  for (const m of matches) {
    await prisma.variant.update({
      where: { id: m.variantDbId },
      data: {
        shopifyVariantId: m.shopifyVariantId,
        shopifyInventoryItemId: m.shopifyInventoryItemId,
      },
    });
    updated++;
  }

  const trueIds = [...productOnShopify.entries()].filter(([, v]) => v).map(([id]) => id);
  const falseIds = [...productOnShopify.entries()].filter(([, v]) => !v).map(([id]) => id);

  if (trueIds.length > 0) {
    await prisma.product.updateMany({ where: { id: { in: trueIds } }, data: { onShopify: true } });
  }
  if (falseIds.length > 0) {
    await prisma.product.updateMany({ where: { id: { in: falseIds } }, data: { onShopify: false } });
  }

  return {
    updated,
    dbUnmatchedCount: dryRun.dbUnmatched.length,
    shopifyUnmatchedCount: dryRun.shopifyUnmatched.length,
    productsSetOnShopifyTrue: trueIds.length,
    productsSetOnShopifyFalse: falseIds.length,
  };
}
