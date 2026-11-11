/**
 * Pass 2 write primitives: add variants to a LIVE product WITHOUT productSet
 * (productSet would re-declare the whole grid; for products past 100 variants
 * we only ever append). Everything here is append-only and logged so a batch
 * can be rolled back by deleting exactly the variants it created.
 *
 * Input shapes were confirmed against the live schema on 2026-11-11
 * (ProductVariantsBulkInput, VariantOptionValueInput, InventoryItemInput).
 */
import { appendFile, readFile } from "node:fs/promises";
import { shopifyGraphQL } from "@/lib/shopify";
import { CORE_REQUIRES_SHIPPING, CORE_WEIGHT_LB } from "@/lib/shipping-config";

export const ADD_LOG_PATH = "size-add-log.jsonl";
export const BULK_CHUNK = 100;

export interface BulkVariantSpec {
  sku: string;
  colorOptionValue: string; // "Red - 600"
  colorGid: string;
  size: string;
  sizeGid: string;
  price: string;
}

export function variantInput(s: BulkVariantSpec) {
  return {
    price: s.price,
    optionValues: [
      { optionName: "Color", name: s.colorOptionValue, linkedMetafieldValue: s.colorGid },
      { optionName: "Size", name: s.size, linkedMetafieldValue: s.sizeGid },
    ],
    inventoryItem: {
      sku: s.sku,
      tracked: true,
      requiresShipping: CORE_REQUIRES_SHIPPING,
      measurement: { weight: { value: CORE_WEIGHT_LB, unit: "POUNDS" } },
    },
  };
}

type UserErrors = { field?: string[]; message: string; code?: string }[];

const OPTION_ADD = `
  mutation addSizeValues($productId: ID!, $option: OptionUpdateInput!, $optionValuesToAdd: [OptionValueCreateInput!]) {
    productOptionUpdate(productId: $productId, option: $option, optionValuesToAdd: $optionValuesToAdd) {
      product { id }
      userErrors { field message code }
    }
  }
`;

/** Add ONLY the missing, linked Size option values. No deletes, no renames, Color untouched. */
export async function addSizeOptionValues(
  productGid: string,
  optionId: string,
  existing: string[],
  wanted: { name: string; gid: string }[],
): Promise<string[]> {
  const missing = wanted.filter((w) => !existing.includes(w.name));
  if (missing.length === 0) return [];
  const res = await shopifyGraphQL<{ productOptionUpdate: { userErrors: UserErrors } }>(OPTION_ADD, {
    productId: productGid,
    option: { id: optionId },
    optionValuesToAdd: missing.map((m) => ({ linkedMetafieldValue: m.gid })),
  });
  if (res.errors?.length) throw new Error(`productOptionUpdate error: ${JSON.stringify(res.errors)}`);
  const ue = res.data?.productOptionUpdate.userErrors ?? [];
  if (ue.length) throw new Error(`productOptionUpdate userErrors: ${JSON.stringify(ue)}`);
  return missing.map((m) => m.name);
}

const BULK_CREATE = `
  mutation createVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      productVariants { id sku }
      userErrors { field message code }
    }
  }
`;

export async function bulkCreateVariants(productGid: string, specs: BulkVariantSpec[], onChunk?: (created: { id: string; sku: string }[]) => Promise<void>): Promise<{ id: string; sku: string }[]> {
  const created: { id: string; sku: string }[] = [];
  for (let i = 0; i < specs.length; i += BULK_CHUNK) {
    const chunk = specs.slice(i, i + BULK_CHUNK);
    const res = await shopifyGraphQL<{ productVariantsBulkCreate: { productVariants: { id: string; sku: string }[] | null; userErrors: UserErrors } }>(BULK_CREATE, {
      productId: productGid,
      variants: chunk.map(variantInput),
    });
    if (res.errors?.length) throw new Error(`productVariantsBulkCreate error: ${JSON.stringify(res.errors)}`);
    const p = res.data?.productVariantsBulkCreate;
    // Log whatever was created BEFORE surfacing errors, so rollback can always find it.
    const made = p?.productVariants ?? [];
    created.push(...made);
    if (made.length && onChunk) await onChunk(made);
    if (!p || p.userErrors.length) throw new Error(`productVariantsBulkCreate userErrors: ${JSON.stringify(p?.userErrors ?? res)}`);
  }
  return created;
}

const BULK_DELETE = `
  mutation deleteVariants($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      userErrors { field message code }
    }
  }
`;

export async function bulkDeleteVariants(productGid: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += BULK_CHUNK) {
    const res = await shopifyGraphQL<{ productVariantsBulkDelete: { userErrors: UserErrors } }>(BULK_DELETE, { productId: productGid, variantsIds: ids.slice(i, i + BULK_CHUNK) });
    if (res.errors?.length) throw new Error(`productVariantsBulkDelete error: ${JSON.stringify(res.errors)}`);
    const ue = res.data?.productVariantsBulkDelete.userErrors ?? [];
    if (ue.length) throw new Error(`productVariantsBulkDelete userErrors: ${JSON.stringify(ue)}`);
  }
}

export interface AddLogEntry {
  at: string;
  batchId: string;
  styleCode: string;
  productGid: string;
  kind: "planned" | "created" | "optionValuesAdded" | "done" | "rolled-back";
  variants?: { id: string; sku: string }[];
  values?: string[];
  method?: "set" | "bulk";
}

export async function appendAddLog(e: Omit<AddLogEntry, "at">): Promise<void> {
  await appendFile(ADD_LOG_PATH, JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n");
}

export async function readAddLog(): Promise<AddLogEntry[]> {
  try {
    return (await readFile(ADD_LOG_PATH, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as AddLogEntry);
  } catch {
    return [];
  }
}
