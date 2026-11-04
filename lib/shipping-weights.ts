/**
 * Weight backfill: every `core` variant is 1 lb + requiresShipping; every
 * `customize_charge` fee item is 0 lb + requiresShipping=false. Idempotent —
 * only variants not already at the target are written. See lib/shipping-config.ts.
 */
import { shopifyGraphQL } from "@/lib/shopify";
import { CORE_TAG } from "@/lib/shopify-tags";
import { FEE_TAG } from "@/lib/order-config";
import {
  CORE_REQUIRES_SHIPPING,
  CORE_WEIGHT_LB,
  FEE_PRODUCT_TITLES,
  FEE_REQUIRES_SHIPPING,
  FEE_WEIGHT_LB,
} from "@/lib/shipping-config";
import { weightInLb } from "@/lib/shopify-draft";

const PACING_MS = 300;
export const BULK_CHUNK = 100;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Role = "core" | "fee";

export interface VariantState {
  id: string;
  sku: string | null;
  productId: string;
  productTitle: string;
  role: Role;
  weightLb: number | null;
  requiresShipping: boolean | null;
}

const expected = (role: Role) =>
  role === "core"
    ? { weightLb: CORE_WEIGHT_LB, requiresShipping: CORE_REQUIRES_SHIPPING }
    : { weightLb: FEE_WEIGHT_LB, requiresShipping: FEE_REQUIRES_SHIPPING };

export const isAtTarget = (v: VariantState) => {
  const e = expected(v.role);
  return v.weightLb === e.weightLb && v.requiresShipping === e.requiresShipping;
};

const PRODUCTS_QUERY = `
  query shipProducts($q: String!, $after: String) {
    products(first: 50, query: $q, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id title }
    }
  }
`;

const VARIANTS_QUERY = `
  query shipVariants($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id sku inventoryItem { requiresShipping measurement { weight { value unit } } } }
      }
    }
  }
`;

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await shopifyGraphQL<T>(query, variables);
  if (res.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(res.errors)}`);
  if (!res.data) throw new Error("GraphQL returned no data");
  return res.data;
}

export async function fetchProductsByTag(tag: string): Promise<{ id: string; title: string }[]> {
  const out: { id: string; title: string }[] = [];
  let after: string | null = null;
  for (;;) {
    const d: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string; title: string }[] } } = await gql(PRODUCTS_QUERY, { q: `tag:${tag}`, after });
    out.push(...d.products.nodes);
    if (!d.products.pageInfo.hasNextPage) return out;
    after = d.products.pageInfo.endCursor;
    await sleep(PACING_MS);
  }
}

export async function fetchVariantStates(product: { id: string; title: string }, role: Role): Promise<VariantState[]> {
  const out: VariantState[] = [];
  let after: string | null = null;
  for (;;) {
    const d: { product: { variants: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: { id: string; sku: string | null; inventoryItem: { requiresShipping: boolean; measurement: { weight: { value: number; unit: string } | null } } | null }[] } } | null } = await gql(VARIANTS_QUERY, { id: product.id, after });
    if (!d.product) throw new Error(`product ${product.id} not found`);
    for (const v of d.product.variants.nodes) {
      out.push({
        id: v.id,
        sku: v.sku,
        productId: product.id,
        productTitle: product.title,
        role,
        weightLb: weightInLb(v.inventoryItem?.measurement.weight ?? null),
        requiresShipping: v.inventoryItem?.requiresShipping ?? null,
      });
    }
    if (!d.product.variants.pageInfo.hasNextPage) return out;
    after = d.product.variants.pageInfo.endCursor;
    await sleep(PACING_MS);
  }
}

export interface WeightScan {
  coreProducts: number;
  feeProducts: { id: string; title: string }[];
  /** Fee-tagged products whose title isn't one of FEE_PRODUCT_TITLES, and expected titles not found. */
  feeTitleProblems: string[];
  variants: VariantState[];
}

/** Reads every core variant and every fee-item variant. A product carrying both tags is treated as a fee. */
export async function scanWeights(): Promise<WeightScan> {
  const fees = await fetchProductsByTag(FEE_TAG);
  const feeIds = new Set(fees.map((p) => p.id));
  const core = (await fetchProductsByTag(CORE_TAG)).filter((p) => !feeIds.has(p.id));

  const feeTitleProblems: string[] = [];
  for (const p of fees) if (!FEE_PRODUCT_TITLES.includes(p.title)) feeTitleProblems.push(`fee-tagged product "${p.title}" (${p.id}) is not one of the 4 known fee titles`);
  for (const t of FEE_PRODUCT_TITLES) if (!fees.some((p) => p.title === t)) feeTitleProblems.push(`expected fee product "${t}" not found under tag ${FEE_TAG}`);

  const variants: VariantState[] = [];
  for (const p of fees) {
    variants.push(...(await fetchVariantStates(p, "fee")));
    await sleep(PACING_MS);
  }
  for (const p of core) {
    variants.push(...(await fetchVariantStates(p, "core")));
    await sleep(PACING_MS);
  }
  return { coreProducts: core.length, feeProducts: fees, feeTitleProblems, variants };
}

const BULK_UPDATE = `
  mutation bulk($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id }
      userErrors { field message }
    }
  }
`;

export function bulkInputFor(v: VariantState) {
  const e = expected(v.role);
  return { id: v.id, inventoryItem: { requiresShipping: e.requiresShipping, measurement: { weight: { value: e.weightLb, unit: "POUNDS" } } } };
}

/** Writes the given variants, grouped per product, BULK_CHUNK at a time. Returns the number written. */
export async function writeWeights(todo: VariantState[]): Promise<number> {
  const byProduct = new Map<string, VariantState[]>();
  for (const v of todo) byProduct.set(v.productId, [...(byProduct.get(v.productId) ?? []), v]);
  let written = 0;
  for (const [productId, vs] of byProduct) {
    for (let i = 0; i < vs.length; i += BULK_CHUNK) {
      const chunk = vs.slice(i, i + BULK_CHUNK);
      const d = await gql<{ productVariantsBulkUpdate: { userErrors: { field: string[] | null; message: string }[] } }>(BULK_UPDATE, {
        productId,
        variants: chunk.map(bulkInputFor),
      });
      const errs = d.productVariantsBulkUpdate.userErrors;
      if (errs.length > 0) throw new Error(`productVariantsBulkUpdate ${productId} userErrors: ${JSON.stringify(errs)}`);
      written += chunk.length;
      await sleep(PACING_MS);
    }
  }
  return written;
}
