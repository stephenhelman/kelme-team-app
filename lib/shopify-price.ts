/**
 * New-variant price guard. A productSet that adds variants without a price
 * creates them at the default (0.00) on a live listing, so every add path must
 * pass the product's CURRENT price. Live products carry one uniform price
 * across all variants; if a product ever has mixed prices we refuse and list
 * it — a human decides what the new size costs.
 */
import { shopifyGraphQL } from "@/lib/shopify";

export class MixedPriceError extends Error {
  constructor(
    public productGid: string,
    public title: string,
    public prices: string[],
  ) {
    super(`mixed variant prices on ${title} (${productGid}): ${prices.join(", ")} — stopped, set the new variants' price by hand`);
  }
}

export interface UniformPrice {
  price: string;
  compareAtPrices: string[]; // distinct non-null compare-at values (informational)
}

const QUERY = `
  query productPrices($id: ID!, $cursor: String) {
    product(id: $id) {
      title
      variants(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { price compareAtPrice }
      }
    }
  }
`;

/** Pure: decide the uniform price from a list of variant prices. Throws MixedPriceError when not uniform. */
export function pickUniformPrice(
  productGid: string,
  title: string,
  variants: { price: string; compareAtPrice: string | null }[],
): UniformPrice {
  const prices = [...new Set(variants.map((v) => Number(v.price).toFixed(2)))];
  if (prices.length === 0) throw new Error(`no variants to read a price from on ${title} (${productGid})`);
  if (prices.length > 1) throw new MixedPriceError(productGid, title, prices);
  if (Number(prices[0]) <= 0) throw new Error(`current price on ${title} (${productGid}) is ${prices[0]} — refusing to propagate a zero price`);
  const compareAtPrices = [...new Set(variants.map((v) => v.compareAtPrice).filter((c): c is string => !!c))];
  return { price: prices[0], compareAtPrices };
}

export async function requireUniformPrice(productGid: string): Promise<UniformPrice> {
  const variants: { price: string; compareAtPrice: string | null }[] = [];
  let title = "";
  let cursor: string | null = null;
  for (;;) {
    const res: {
      data?: { product: { title: string; variants: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { price: string; compareAtPrice: string | null }[] } } | null };
      errors?: { message: string }[];
    } = await shopifyGraphQL(QUERY, { id: productGid, cursor });
    if (res.errors?.length) throw new Error(`price query error: ${JSON.stringify(res.errors)}`);
    const p = res.data?.product;
    if (!p) throw new Error(`product ${productGid} not found`);
    title = p.title;
    variants.push(...p.variants.nodes);
    if (!p.variants.pageInfo.hasNextPage) break;
    cursor = p.variants.pageInfo.endCursor;
  }
  return pickUniformPrice(productGid, title, variants);
}
