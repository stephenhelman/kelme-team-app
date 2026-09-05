/**
 * Reorders a product's Size option values into canonical display order via
 * productOptionsReorder. Size is the priority; Color's current order is
 * preserved by re-sending it unchanged in the same call — the API requires
 * every option to be present in the payload (confirmed empirically:
 * omitting Color errors with "Missing option name 'Color'", it's not a
 * silent no-op for the omitted option).
 */
import { shopifyGraphQL } from "@/lib/shopify";

export const CANONICAL_SIZE_ORDER = [
  "4",
  "6",
  "8",
  "10",
  "12",
  "14",
  "16",
  "2XS",
  "XS",
  "S",
  "M",
  "L",
  "XL",
  "2XL",
  "3XL",
  "One Size",
];

function sizeRank(size: string): number {
  const idx = CANONICAL_SIZE_ORDER.indexOf(size);
  return idx === -1 ? CANONICAL_SIZE_ORDER.length + 1 : idx; // unknown sizes sort last, stable
}

function shopifyProductGid(id: number): string {
  return `gid://shopify/Product/${id}`;
}

interface OptionValueRow {
  id: string;
  name: string;
}
interface OptionRow {
  id: string;
  name: string;
  optionValues: OptionValueRow[];
}

const PRODUCT_OPTIONS_QUERY = `
  query productOptionsForReorder($id: ID!) {
    product(id: $id) {
      options { id name optionValues { id name } }
    }
  }
`;

const REORDER_MUTATION = `
  mutation productOptionsReorder($productId: ID!, $options: [OptionReorderInput!]!) {
    productOptionsReorder(productId: $productId, options: $options) {
      userErrors { field message }
    }
  }
`;

async function fetchOptions(shopifyProductId: number): Promise<OptionRow[]> {
  const res = await shopifyGraphQL<{ product: { options: OptionRow[] } | null }>(PRODUCT_OPTIONS_QUERY, {
    id: shopifyProductGid(shopifyProductId),
  });
  if (res.errors?.length) throw new Error(`productOptions query error: ${JSON.stringify(res.errors)}`);
  return res.data?.product?.options ?? [];
}

export interface SizeOrderPlan {
  shopifyProductId: number;
  hasSizeOption: boolean;
  currentSizeOrder: string[];
  targetSizeOrder: string[];
  changed: boolean;
}

export async function planSizeOrder(shopifyProductId: number): Promise<SizeOrderPlan> {
  const options = await fetchOptions(shopifyProductId);
  const sizeOpt = options.find((o) => o.name === "Size");
  if (!sizeOpt) {
    return { shopifyProductId, hasSizeOption: false, currentSizeOrder: [], targetSizeOrder: [], changed: false };
  }

  const currentSizeOrder = sizeOpt.optionValues.map((v) => v.name);
  const targetSizeOrder = [...sizeOpt.optionValues].sort((a, b) => sizeRank(a.name) - sizeRank(b.name)).map((v) => v.name);

  return {
    shopifyProductId,
    hasSizeOption: true,
    currentSizeOrder,
    targetSizeOrder,
    changed: JSON.stringify(currentSizeOrder) !== JSON.stringify(targetSizeOrder),
  };
}

export interface SizeOrderExecuteResult {
  shopifyProductId: number;
  changed: boolean;
  after: string[];
}

export async function executeSizeOrder(shopifyProductId: number): Promise<SizeOrderExecuteResult> {
  const options = await fetchOptions(shopifyProductId);
  const sizeOpt = options.find((o) => o.name === "Size");
  if (!sizeOpt) return { shopifyProductId, changed: false, after: [] };

  const currentSizeOrder = sizeOpt.optionValues.map((v) => v.name);
  const targetValues = [...sizeOpt.optionValues].sort((a, b) => sizeRank(a.name) - sizeRank(b.name));
  const targetSizeOrder = targetValues.map((v) => v.name);

  if (JSON.stringify(currentSizeOrder) === JSON.stringify(targetSizeOrder)) {
    return { shopifyProductId, changed: false, after: currentSizeOrder };
  }

  const optionsPayload = options.map((o) =>
    o.id === sizeOpt.id
      ? { id: o.id, values: targetValues.map((v) => ({ id: v.id })) }
      : { id: o.id, values: o.optionValues.map((v) => ({ id: v.id })) },
  );

  const mutRes = await shopifyGraphQL<{ productOptionsReorder: { userErrors: { field: string[] | null; message: string }[] } }>(
    REORDER_MUTATION,
    { productId: shopifyProductGid(shopifyProductId), options: optionsPayload },
  );
  if (mutRes.errors?.length) throw new Error(`productOptionsReorder GraphQL error: ${JSON.stringify(mutRes.errors)}`);
  const userErrors = mutRes.data?.productOptionsReorder.userErrors ?? [];
  if (userErrors.length > 0) throw new Error(`productOptionsReorder userErrors: ${JSON.stringify(userErrors)}`);

  const after = await fetchOptions(shopifyProductId);
  const afterSize = after.find((o) => o.name === "Size")?.optionValues.map((v) => v.name) ?? [];
  return { shopifyProductId, changed: true, after: afterSize };
}
