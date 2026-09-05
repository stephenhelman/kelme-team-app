/**
 * Reconciles a Shopify product's Color/Size options + variant grid against
 * the authoritative Variant rows in our DB, keyed by styleCode. Structure
 * only — never writes SKUs or inventory (see lib/shopify-link.ts for SKU
 * linking, which is re-run after this pass since option updates mint new
 * Shopify variant/inventory_item ids).
 *
 * Three gated entry points, meant to be run in order with human review
 * between each:
 *   - dryRunReconcile   — read-only. Prints the predicted add/delete diff.
 *   - executeReconcile  — writes options for ONE product, re-pulls, reports
 *                         actual vs predicted (does Shopify auto-propagate?).
 *   - batchReconcile    — runs executeReconcile across every matched
 *                         product, resumable via a per-product log file.
 */
import { appendFile, readFile } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { shopifyAdminFetch, shopifyGraphQL, parseNextPageUrl } from "@/lib/shopify";
import { buildSku } from "@/lib/sku";

const CALL_PACING_MS = 400;
const BATCH_LOG_PATH = path.join(process.cwd(), "shopify-reconcile-log.jsonl");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Shopify REST shapes ---

export interface ShopifyOption {
  id: number;
  name: string;
  position: number;
  values: string[];
}

export interface ShopifyVariant {
  id: number;
  inventory_item_id: number;
  sku: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

export interface ShopifyProduct {
  id: number;
  title: string;
  options: ShopifyOption[];
  variants: ShopifyVariant[];
}

async function fetchAllShopifyProducts(): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];
  let nextUrl: string | null = "/products.json?limit=250";
  let page = 0;

  while (nextUrl) {
    const res = await shopifyAdminFetch(nextUrl);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify request failed: HTTP ${res.status} ${body}`);
    }
    const json = (await res.json()) as { products: ShopifyProduct[] };
    products.push(...json.products);

    nextUrl = parseNextPageUrl(res.headers.get("Link"));
    page += 1;
    if (nextUrl) await sleep(CALL_PACING_MS);
  }

  console.log(`[shopify-reconcile] pulled ${products.length} products`);
  return products;
}

// REST's /products/{id}.json silently caps the embedded variants array at
// 100 — no error, no truncation flag, confirmed live against a 126-variant
// product (GraphQL returned all 126, REST returned exactly 100). Any
// product that has ever exceeded 100 variants needs its variants fetched
// separately via the paginated /products/{id}/variants.json sub-resource
// and merged in, or every diff computed from this function silently
// undercounts what's actually deleted/extra.
export async function fetchOneShopifyProduct(id: number): Promise<ShopifyProduct> {
  const res = await shopifyAdminFetch(`/products/${id}.json`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify request failed: HTTP ${res.status} ${body}`);
  }
  const json = (await res.json()) as { product: ShopifyProduct };
  const product = json.product;

  if (product.variants.length >= 100) {
    const variants: ShopifyVariant[] = [];
    let nextUrl: string | null = `/products/${id}/variants.json?limit=250`;
    while (nextUrl) {
      const vres = await shopifyAdminFetch(nextUrl);
      if (!vres.ok) {
        const body = await vres.text();
        throw new Error(`Shopify variants request failed: HTTP ${vres.status} ${body}`);
      }
      const vjson = (await vres.json()) as { variants: ShopifyVariant[] };
      variants.push(...vjson.variants);
      nextUrl = parseNextPageUrl(vres.headers.get("Link"));
      if (nextUrl) await sleep(CALL_PACING_MS);
    }
    product.variants = variants;
  }

  return product;
}

// --- GraphQL productSet: declares the full target options + variant grid,
// letting Shopify diff it against current state (create/update/delete) in
// one call. REST product PUT with an `options` body is a silent no-op as of
// API 2026-07 — confirmed empirically, hence GraphQL here.

const PRODUCT_SET_MUTATION = `
  mutation productSet($input: ProductSetInput!, $synchronous: Boolean!) {
    productSet(input: $input, synchronous: $synchronous) {
      product { id }
      productSetOperation { id status }
      userErrors { field message }
    }
  }
`;

const PRODUCT_OPERATION_QUERY = `
  query productOperation($id: ID!) {
    productOperation(id: $id) {
      status
      ... on ProductSetOperation {
        product { id }
        userErrors { field message }
      }
    }
  }
`;

interface ProductSetMutationResponse {
  productSet: {
    product: { id: string } | null;
    productSetOperation: { id: string; status: string } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

interface ProductOperationQueryResponse {
  productOperation: {
    status: string;
    product: { id: string } | null;
    userErrors: { field: string[] | null; message: string }[];
  } | null;
}

function shopifyProductGid(id: number): string {
  return `gid://shopify/Product/${id}`;
}

// productSet rejects a variant that references a linked option value
// (Color/Size) which doesn't already exist on the product's option — "You
// need to add option values for Size" — even though the same call also
// declares that value in productOptions. A brand-new linked value must be
// created via productOptionUpdate first; only then can productSet's
// variants reference it. Values that already exist (as free text or
// already-linked) go through productSet as before — this only pre-creates
// what's missing.

const PRODUCT_OPTIONS_QUERY = `
  query productOptions($id: ID!) {
    product(id: $id) {
      options {
        id
        name
        linkedMetafield { namespace key }
        optionValues { id name }
      }
    }
  }
`;

// namespace/key each option links to — same pair used when creating the
// metafield-linked options originally (shopify's built-in swatch/size
// system). Confirmed live: an option can sit at linkedMetafield: null
// indefinitely even after values are added elsewhere in the catalog — some
// products in this shop were linked via the Shopify admin UI at some point
// and some never were, independent of anything this pipeline has done.
const OPTION_LINKED_METAFIELD: Record<string, { namespace: string; key: string }> = {
  Color: { namespace: "shopify", key: "color-pattern" },
  Size: { namespace: "shopify", key: "size" },
  "Ball size": { namespace: "shopify", key: "ball-size" },
};

const OPTION_UPDATE_MUTATION = `
  mutation productOptionUpdate(
    $productId: ID!
    $option: OptionUpdateInput!
    $optionValuesToAdd: [OptionValueCreateInput!]
    $optionValuesToUpdate: [OptionValueUpdateInput!]
  ) {
    productOptionUpdate(
      productId: $productId
      option: $option
      optionValuesToAdd: $optionValuesToAdd
      optionValuesToUpdate: $optionValuesToUpdate
      variantStrategy: LEAVE_AS_IS
    ) {
      product { id }
      userErrors { field message }
    }
  }
`;

// Deletes stray current option values that have no target match at all
// (colors/sizes on the product but not in the DB target) — a separate call
// from add/update, and MANAGE here specifically because LEAVE_AS_IS
// refuses to delete a value with variants attached ("an error will be
// returned"). MANAGE for ADD would create unwanted cross-product variants,
// which is why this is split out rather than combined with the add/update
// call below.
const OPTION_DELETE_VALUES_MUTATION = `
  mutation productOptionUpdateDelete($productId: ID!, $option: OptionUpdateInput!, $optionValuesToDelete: [ID!]) {
    productOptionUpdate(
      productId: $productId
      option: $option
      optionValuesToDelete: $optionValuesToDelete
      variantStrategy: MANAGE
    ) {
      product { id }
      userErrors { field message }
    }
  }
`;

// Used only for the zero-overlap case (see below): combining add and
// delete in one call means the option is never actually reduced to zero
// values, so this is safe even though it uses MANAGE (unwanted
// cross-product variant creation from MANAGE isn't a concern here since
// productSet immediately after declares the full target grid regardless).
const OPTION_ADD_DELETE_MUTATION = `
  mutation productOptionUpdateReplace(
    $productId: ID!
    $option: OptionUpdateInput!
    $optionValuesToAdd: [OptionValueCreateInput!]
    $optionValuesToDelete: [ID!]
  ) {
    productOptionUpdate(
      productId: $productId
      option: $option
      optionValuesToAdd: $optionValuesToAdd
      optionValuesToDelete: $optionValuesToDelete
      variantStrategy: MANAGE
    ) {
      product { id }
      userErrors { field message }
    }
  }
`;

// A product with NO Color or Size option at all (colorless single-Title
// listings; ball listings with a Color option but no Size option) can't go
// through productOptionUpdate at all — there's no existing option to
// target. productSet itself can't create a brand-new option pre-linked
// either: it rejects any variant referencing a linked value that doesn't
// already exist on the product ("You need to add option values for Size"),
// even though the same call also declares that value in productOptions.
// productOptionsCreate is the one mutation that can create an option with
// its values already linked to a metafield in a single call.
// variantStrategy: LEAVE_AS_IS so this call only establishes the option —
// no variants are touched — leaving the full variant grid to the productSet
// call that follows in setShopifyProductStructure.
const OPTION_CREATE_MUTATION = `
  mutation productOptionsCreate($productId: ID!, $options: [OptionCreateInput!]!) {
    productOptionsCreate(productId: $productId, options: $options, variantStrategy: LEAVE_AS_IS) {
      product { id }
      userErrors { field message }
    }
  }
`;

interface ProductOptionsCreateResponse {
  productOptionsCreate: {
    product: { id: string } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

interface ProductOptionsQueryResponse {
  product: {
    options: {
      id: string;
      name: string;
      linkedMetafield: { namespace: string; key: string } | null;
      optionValues: { id: string; name: string }[];
    }[];
  } | null;
}

interface ProductOptionUpdateResponse {
  productOptionUpdate: {
    product: { id: string } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

// A product whose option has NEVER been linked starts with every value as
// plain free text ("Red"), while our target names carry the code suffix
// ("Red - 600") — so a same-value name match never hits, and naively
// sending the target as a brand-new optionValuesToAdd entry leaves the old
// plain "Red" sitting on the option unlinked, which Shopify rejects
// outright ("An option cannot have both metafield linked and nonlinked
// option values") the moment a linked value is added alongside it — this
// isn't a mid-call race, it's a standing-state rule enforced on every call.
// The fix: match the existing value by its bare name (the part before
// " - ") and UPDATE it in place — optionValuesToUpdate is matched by id,
// not name, so it can rename "Red" -> "Red - 600" and attach the GID in
// the same edit, never leaving an unlinked value behind. Genuinely new
// values (no existing match at all) still go through optionValuesToAdd.
// Confirmed via Shopify's own productOptionUpdate docs example, which
// sends optionValuesToAdd and optionValuesToUpdate together in one call.
async function ensureOptionValuesExist(
  shopifyProductId: number,
  colorValues: OptionValueTarget[],
  sizeValues: OptionValueTarget[],
  sizeOptionName: string | null = "Size",
): Promise<{ colorOptionName: string; sizeOptionName: string | null }> {
  const res = await shopifyGraphQL<ProductOptionsQueryResponse>(PRODUCT_OPTIONS_QUERY, {
    id: shopifyProductGid(shopifyProductId),
  });
  if (res.errors?.length) {
    throw new Error(`productOptions query error: ${JSON.stringify(res.errors)}`);
  }
  const options = res.data?.product?.options ?? [];
  const resolvedNames: { colorOptionName: string; sizeOptionName: string | null } = { colorOptionName: "Color", sizeOptionName };

  // sizeOptionName === null means this product has NO size dimension at
  // all (e.g. equipment where every variant is "One Size") — only Color
  // gets ensured; any stray Size-like option already on the product is
  // deleted separately, before this call, by the caller.
  const entries = (sizeOptionName === null ? [["Color", colorValues, 1] as const] : [["Color", colorValues, 1] as const, [sizeOptionName, sizeValues, 2] as const]);

  for (const [optionLabel, targetValues, position] of entries) {
    // Prefer matching by the metafield it's ALREADY linked to over matching
    // by name — Shopify can pre-populate an option under either name (e.g.
    // a "Size"-named option already linked to shopify.ball-size, seen live
    // on a Soccer Balls product) independent of anything this pipeline has
    // done. Trusting name alone risks creating a second, redundant option
    // that then collides with the existing link ("An option linked to the
    // '...' metafield already exists").
    const expectedKey = OPTION_LINKED_METAFIELD[optionLabel]?.key;
    let option = options.find((o) => o.linkedMetafield?.key === expectedKey) ?? options.find((o) => o.name === optionLabel);
    if (!option) {
      if (targetValues.length === 0) continue; // nothing to create

      // productOptionsCreate rejects combining `linkedMetafield` on the
      // option with `linkedMetafieldValue` on its values in the same call
      // ("Cannot combine linked metafield and option values.") — confirmed
      // live. So this creates the option PLAIN (no link, values named with
      // the final target text but no linkedMetafieldValue yet), then falls
      // through to the shared link/convert logic below — the exact same
      // path already proven for an existing-but-never-linked option, which
      // matches by exact name and converts via optionValuesToUpdate.
      console.log(
        `[shopify-reconcile] ${optionLabel} on product=${shopifyProductId}: ` +
          `option doesn't exist yet — creating it plain with ${targetValues.length} value(s), to be linked next`,
      );
      const createRes = await shopifyGraphQL<ProductOptionsCreateResponse>(OPTION_CREATE_MUTATION, {
        productId: shopifyProductGid(shopifyProductId),
        options: [
          {
            name: optionLabel,
            position,
            values: targetValues.map((v) => ({ name: v.name })),
          },
        ],
      });
      if (createRes.errors?.length) {
        throw new Error(`productOptionsCreate GraphQL error: ${JSON.stringify(createRes.errors)}`);
      }
      const createPayload = createRes.data?.productOptionsCreate;
      if (!createPayload) {
        throw new Error(`productOptionsCreate returned no payload: ${JSON.stringify(createRes)}`);
      }
      if (createPayload.userErrors.length > 0) {
        throw new Error(`productOptionsCreate userErrors: ${JSON.stringify(createPayload.userErrors)}`);
      }
      await sleep(CALL_PACING_MS);

      const requery = await shopifyGraphQL<ProductOptionsQueryResponse>(PRODUCT_OPTIONS_QUERY, {
        id: shopifyProductGid(shopifyProductId),
      });
      if (requery.errors?.length) {
        throw new Error(`productOptions requery error after create: ${JSON.stringify(requery.errors)}`);
      }
      option = requery.data?.product?.options.find((o) => o.name === optionLabel);
      if (!option) {
        throw new Error(`option "${optionLabel}" not found immediately after productOptionsCreate on product=${shopifyProductId}`);
      }
    }

    // Record the option's ACTUAL live name — it may differ from our
    // assumed `optionLabel` when matched by linked metafield (e.g. found by
    // ball-size link but actually named "Size" on this product). Every
    // downstream call (productSet's variant optionValues, in particular)
    // must reference the real name, not our guess.
    if (targetValues === colorValues) resolvedNames.colorOptionName = option.name;
    else resolvedNames.sizeOptionName = option.name as string;

    const usedCurrentIds = new Set<string>();
    const toAdd: OptionValueTarget[] = [];
    const toUpdate: { id: string; name: string; gid: string }[] = [];

    for (const target of targetValues) {
      // 1. Already-linked (or previously renamed) value with the exact
      //    target text — nothing to change, but re-sending is cheap and
      //    covers a partially-converted option from an earlier failed run.
      let current = option.optionValues.find((v) => v.name === target.name && !usedCurrentIds.has(v.id));
      // 2. Plain, never-linked value — matched by the bare name before
      //    " - code".
      if (!current) {
        const plainName = target.name.includes(" - ") ? target.name.split(" - ")[0] : target.name;
        current = option.optionValues.find((v) => v.name === plainName && !usedCurrentIds.has(v.id));
      }
      if (current) {
        usedCurrentIds.add(current.id);
        toUpdate.push({ id: current.id, name: target.name, gid: target.gid });
      } else {
        toAdd.push(target);
      }
    }

    // Any current value matched to no target at all (a color/size on the
    // product that isn't in the DB target — about to be deleted anyway per
    // the variant diff) would otherwise sit untouched and still plain-text
    // after this step, leaving the option in exactly the mixed state
    // Shopify rejects. Delete it first so nothing unlinked is left behind.
    const toDelete = option.optionValues.filter((v) => !usedCurrentIds.has(v.id));

    // Deleting EVERY current value would leave the option with zero values,
    // which Shopify rejects outright ("Cannot delete all option values in
    // an option") — happens when a product's current colors/sizes have no
    // overlap at all with the DB target (toUpdate is necessarily empty in
    // this case). Confirmed live: combining the add and the delete in ONE
    // call sidesteps it entirely — Shopify validates the call's *net*
    // result, not an intermediate empty state, so adding the new values in
    // the same call that removes the old ones never actually hits zero.
    if (toDelete.length > 0 && toDelete.length === option.optionValues.length && toAdd.length > 0) {
      const linkedMetafield = !option.linkedMetafield ? OPTION_LINKED_METAFIELD[optionLabel] : undefined;
      console.log(
        `[shopify-reconcile] ${optionLabel} on product=${shopifyProductId}: ` +
          `zero overlap with current values — replacing all ${toDelete.length} in one add+delete call` +
          (linkedMetafield ? ` (also linking the option)` : ""),
      );
      const res = await shopifyGraphQL<ProductOptionUpdateResponse>(OPTION_ADD_DELETE_MUTATION, {
        productId: shopifyProductGid(shopifyProductId),
        option: linkedMetafield ? { id: option.id, linkedMetafield } : { id: option.id },
        optionValuesToAdd: toAdd.map((v) => ({ linkedMetafieldValue: v.gid })),
        optionValuesToDelete: toDelete.map((v) => v.id),
      });
      if (res.errors?.length) {
        throw new Error(`productOptionUpdate (replace all) GraphQL error: ${JSON.stringify(res.errors)}`);
      }
      const payload = res.data?.productOptionUpdate;
      if (!payload) {
        throw new Error(`productOptionUpdate (replace all) returned no payload: ${JSON.stringify(res)}`);
      }
      if (payload.userErrors.length > 0) {
        throw new Error(`productOptionUpdate (replace all) userErrors: ${JSON.stringify(payload.userErrors)}`);
      }
      await sleep(CALL_PACING_MS);
      continue;
    }

    if (toDelete.length > 0) {
      console.log(
        `[shopify-reconcile] ${optionLabel} on product=${shopifyProductId}: ` +
          `deleting ${toDelete.length} stray value(s) with no DB target match: ${toDelete.map((v) => v.name).join(", ")}`,
      );
      const deleteRes = await shopifyGraphQL<ProductOptionUpdateResponse>(OPTION_DELETE_VALUES_MUTATION, {
        productId: shopifyProductGid(shopifyProductId),
        option: { id: option.id },
        optionValuesToDelete: toDelete.map((v) => v.id),
      });
      if (deleteRes.errors?.length) {
        throw new Error(`productOptionUpdate (delete) GraphQL error: ${JSON.stringify(deleteRes.errors)}`);
      }
      const deletePayload = deleteRes.data?.productOptionUpdate;
      if (!deletePayload) {
        throw new Error(`productOptionUpdate (delete) returned no payload: ${JSON.stringify(deleteRes)}`);
      }
      if (deletePayload.userErrors.length > 0) {
        throw new Error(`productOptionUpdate (delete) userErrors: ${JSON.stringify(deletePayload.userErrors)}`);
      }
      await sleep(CALL_PACING_MS);
    }

    if (toAdd.length === 0 && toUpdate.length === 0 && option.linkedMetafield) continue;

    async function runOptionUpdate(
      variables: Record<string, unknown>,
      label: string,
    ): Promise<void> {
      const res = await shopifyGraphQL<ProductOptionUpdateResponse>(OPTION_UPDATE_MUTATION, variables);
      if (res.errors?.length) {
        throw new Error(`productOptionUpdate (${label}) GraphQL error: ${JSON.stringify(res.errors)}`);
      }
      const payload = res.data?.productOptionUpdate;
      if (!payload) {
        throw new Error(`productOptionUpdate (${label}) returned no payload: ${JSON.stringify(res)}`);
      }
      if (payload.userErrors.length > 0) {
        throw new Error(`productOptionUpdate (${label}) userErrors: ${JSON.stringify(payload.userErrors)}`);
      }
      await sleep(CALL_PACING_MS);
    }

    if (!option.linkedMetafield) {
      // Linking an option to a metafield for the first time requires a
      // linkedMetafieldValue for EVERY value that exists on it at that
      // moment — confirmed via Shopify's own error text ("A
      // linked_metafield_value must be specified for each existing option
      // value when linking to ..."). After the stray-deletion step above,
      // toUpdate covers exactly the values that remain, so this single
      // call both links the option and converts all of them together.
      // optionValuesToAdd must NOT be included here — combining it with
      // establishing linkedMetafield in the same call still errors
      // ("cannot have both metafield linked and nonlinked option values"),
      // confirmed live; brand-new values are added in a separate call
      // below, once the option is already linked.
      const linkedMetafield = OPTION_LINKED_METAFIELD[optionLabel];
      console.log(
        `[shopify-reconcile] ${optionLabel} on product=${shopifyProductId}: ` +
          `linking the option to ${linkedMetafield.namespace}.${linkedMetafield.key} and converting ` +
          `${toUpdate.length} existing value(s) in one call`,
      );
      await runOptionUpdate(
        {
          productId: shopifyProductGid(shopifyProductId),
          option: { id: option.id, linkedMetafield },
          optionValuesToUpdate: toUpdate.map((v) => ({ id: v.id, linkedMetafieldValue: v.gid })),
        },
        "link option + convert existing",
      );

      if (toAdd.length > 0) {
        console.log(
          `[shopify-reconcile] ${optionLabel} on product=${shopifyProductId}: ` +
            `adding ${toAdd.length} new linked value(s) now that the option is linked`,
        );
        await runOptionUpdate(
          {
            productId: shopifyProductGid(shopifyProductId),
            option: { id: option.id },
            optionValuesToAdd: toAdd.map((v) => ({ linkedMetafieldValue: v.gid })),
          },
          "add new",
        );
      }
      continue;
    }

    // Option was already linked — add and update together, as before.
    console.log(
      `[shopify-reconcile] ${optionLabel} on product=${shopifyProductId}: ` +
        `adding ${toAdd.length} new linked value(s), converting ${toUpdate.length} existing value(s) to linked`,
    );
    await runOptionUpdate(
      {
        productId: shopifyProductGid(shopifyProductId),
        option: { id: option.id },
        optionValuesToAdd: toAdd.length > 0 ? toAdd.map((v) => ({ linkedMetafieldValue: v.gid })) : undefined,
        optionValuesToUpdate:
          toUpdate.length > 0 ? toUpdate.map((v) => ({ id: v.id, linkedMetafieldValue: v.gid })) : undefined,
      },
      "add + update",
    );
  }

  return resolvedNames;
}

// A Color/Size option value that's linked to a metaobject definition (as
// ours are — shopify.color-pattern / shopify.size) must be written with
// linkedMetafieldValue = the metaobject GID. Passing free text for a
// linked option's value silently fails to apply (userErrors-free but the
// value never sticks) — this is the bug this module fixes.
export interface OptionValueTarget {
  name: string;
  gid: string;
}

// NOTE on schema shape (confirmed via introspection against API 2026-07):
// OptionSetInput.values is [OptionValueSetInput], which carries only
// id/name — it has NO linkedMetafieldValue field. The link is instead
// carried per-variant: ProductVariantSetInput.optionValues is
// [VariantOptionValueInput], which has name/optionName PLUS
// linkedMetafieldValue. Shopify resolves/creates each linked option value
// from the GID supplied there, so the metaobject reference must be set on
// every variant's optionValues entry, not on the top-level option
// declaration.
export function buildMutationInput(
  shopifyProductId: number,
  colorValues: OptionValueTarget[],
  sizeValues: OptionValueTarget[],
  target: TargetVariant[],
  sizeOptionName: string | null = "Size",
) {
  const productOptions = [{ name: "Color", position: 1, values: colorValues.map((v) => ({ name: v.name })) }];
  if (sizeOptionName !== null) {
    productOptions.push({ name: sizeOptionName, position: 2, values: sizeValues.map((v) => ({ name: v.name })) });
  }

  return {
    id: shopifyProductGid(shopifyProductId),
    productOptions,
    variants: target.map((t) => ({
      sku: buildSku(t.styleCode, t.colorCode, t.size),
      optionValues:
        sizeOptionName === null
          ? [{ optionName: "Color", name: colorOptionValue(t.colorName, t.colorCode), linkedMetafieldValue: t.colorGid }]
          : [
              { optionName: "Color", name: colorOptionValue(t.colorName, t.colorCode), linkedMetafieldValue: t.colorGid },
              { optionName: sizeOptionName, name: t.size, linkedMetafieldValue: t.sizeGid },
            ],
    })),
  };
}

export async function setShopifyProductStructure(
  shopifyProductId: number,
  colorValues: OptionValueTarget[],
  sizeValues: OptionValueTarget[],
  target: TargetVariant[],
  sizeOptionName: string | null = "Size",
): Promise<number> {
  const resolved = await ensureOptionValuesExist(shopifyProductId, colorValues, sizeValues, sizeOptionName);

  const input = buildMutationInput(shopifyProductId, colorValues, sizeValues, target, resolved.sizeOptionName);

  console.log(
    `[shopify-reconcile] sending productSet mutation for product=${shopifyProductId}: ` +
      `${PRODUCT_SET_MUTATION.trim()} variables=${JSON.stringify({ input, synchronous: target.length <= 100 })}`,
  );

  const res = await shopifyGraphQL<ProductSetMutationResponse>(PRODUCT_SET_MUTATION, {
    input,
    synchronous: target.length <= 100,
  });

  if (res.errors?.length) {
    throw new Error(`productSet GraphQL error: ${JSON.stringify(res.errors)}`);
  }
  const payload = res.data?.productSet;
  if (!payload) {
    throw new Error(`productSet returned no payload: ${JSON.stringify(res)}`);
  }
  if (payload.userErrors.length > 0) {
    throw new Error(`productSet userErrors: ${JSON.stringify(payload.userErrors)}`);
  }

  if (payload.product) {
    console.log(`[shopify-reconcile] productSet completed synchronously for ${payload.product.id}`);
    return shopifyProductId;
  }

  if (!payload.productSetOperation) {
    throw new Error(`productSet returned neither product nor productSetOperation: ${JSON.stringify(payload)}`);
  }

  // Async path — poll until the operation completes.
  const opId = payload.productSetOperation.id;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(1000);
    const pollRes = await shopifyGraphQL<ProductOperationQueryResponse>(PRODUCT_OPERATION_QUERY, { id: opId });
    if (pollRes.errors?.length) {
      throw new Error(`productOperation poll error: ${JSON.stringify(pollRes.errors)}`);
    }
    const op = pollRes.data?.productOperation;
    if (!op) throw new Error(`productOperation ${opId} not found while polling`);
    console.log(`[shopify-reconcile] productSetOperation ${opId} status=${op.status}`);

    if (op.status === "COMPLETE") {
      if (op.userErrors.length > 0) {
        throw new Error(`productSetOperation userErrors: ${JSON.stringify(op.userErrors)}`);
      }
      return shopifyProductId;
    }
    if (op.status === "FAILED") {
      throw new Error(`productSetOperation failed: ${JSON.stringify(op)}`);
    }
  }

  throw new Error(`productSetOperation ${opId} did not complete after polling`);
}

// --- Matching Shopify products to DB products by styleCode ---

function findCandidates(styleCode: string, products: ShopifyProduct[]): ShopifyProduct[] {
  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(styleCode)}([^A-Za-z0-9]|$)`);
  return products.filter((p) => re.test(p.title));
}

function matchShopifyProduct(
  styleCode: string,
  products: ShopifyProduct[],
  exactTitle?: string,
): { product: ShopifyProduct | null; candidateCount: number } {
  const candidates = findCandidates(styleCode, products);
  if (exactTitle) {
    const exact = candidates.find((p) => p.title === exactTitle);
    if (exact) return { product: exact, candidateCount: candidates.length };
  }
  if (candidates.length === 1) return { product: candidates[0], candidateCount: 1 };
  return { product: null, candidateCount: candidates.length };
}

// --- Target computation from DB ---

export interface TargetVariant {
  styleCode: string;
  colorCode: string;
  colorName: string;
  colorGid: string | null;
  size: string;
  sizeGid: string | null;
}

// Same heuristic as lib/kelme-capture.ts's isBallProduct — duplicated
// rather than imported so this module (used for live Shopify writes)
// doesn't pull in lib/kelme.ts's KELME_TOKEN requirement just for a
// 2-line name check.
const NON_BALL_QUALIFIERS = /\b(set|shorts|shirt|socks|bag|net|board)\b/i;
function isBallProduct(name: string): boolean {
  return /ball/i.test(name) && !NON_BALL_QUALIFIERS.test(name);
}

// The Size-equivalent option name + linked metafield to use for a product.
// Shopify's shopify.size metafield is taxonomy-scoped to apparel — balls
// (Soccer Balls category) are rejected outright if linked to it ("At least
// one value ... is invalid", confirmed live) and use a separate "Ball size"
// option linked to shopify.ball-size instead. Every other non-apparel
// equipment category (backpacks, markers, agility gear, ...) has no
// taxonomy-valid linked metafield at all — those get a plain unlinked Size
// option (sizeGid stays null, handled by the plain-add/update path).
export interface SizeOptionKind {
  optionName: string;
  sizeGidField: "shopifyGid" | "ballSizeGid";
}
function sizeOptionKindFor(productName: string): SizeOptionKind {
  return isBallProduct(productName) ? { optionName: "Ball size", sizeGidField: "ballSizeGid" } : { optionName: "Size", sizeGidField: "shopifyGid" };
}

export async function getDbTarget(
  styleCode: string,
): Promise<{ productId: number; target: TargetVariant[]; sizeOptionName: string | null } | null> {
  const product = await prisma.product.findFirst({
    where: { styleCode },
    include: { variants: { orderBy: [{ colorCode: "asc" }, { shopifySize: "asc" }] } },
  });
  if (!product) return null;

  const colorCodes = [...new Set(product.variants.map((v) => v.colorCode))];
  const sizes = [...new Set(product.variants.map((v) => v.shopifySize))];

  // A product whose ONLY size is the literal "One Size" has no real size
  // dimension at all (equipment: backpacks, bags, markers, armbands, ...) —
  // it gets no Size option whatsoever, not even a plain-text one. This is
  // distinct from a ball with a single real size ("4" alone, say), which
  // still gets a genuine Ball size option — the signal here is the literal
  // "One Size" value, not the size count.
  const hasNoSizeDimension = sizes.length === 1 && sizes[0] === "One Size";
  const { optionName: sizeOptionName, sizeGidField } = hasNoSizeDimension
    ? { optionName: null as string | null, sizeGidField: "shopifyGid" as const }
    : sizeOptionKindFor(product.name);

  const [colors, sizeRows] = await Promise.all([
    prisma.color.findMany({ where: { colorCode: { in: colorCodes } } }),
    prisma.size.findMany({ where: { shopifySize: { in: sizes } } }),
  ]);
  const colorGidByCode = new Map(colors.map((c) => [c.colorCode, c.shopifyGid]));
  const sizeGidBySize = new Map(sizeRows.map((s) => [s.shopifySize, s[sizeGidField]]));

  const target = product.variants.map((v) => ({
    styleCode,
    colorCode: v.colorCode,
    colorName: v.colorName,
    colorGid: colorGidByCode.get(v.colorCode) ?? null,
    size: v.shopifySize,
    sizeGid: sizeGidBySize.get(v.shopifySize) ?? null,
  }));
  return { productId: product.id, target, sizeOptionName };
}

export function colorOptionValue(colorName: string, colorCode: string): string {
  return `${colorName} - ${colorCode}`;
}

export function parseColorCode(optionValue: string | null): string | null {
  if (!optionValue) return null;
  const idx = optionValue.lastIndexOf(" - ");
  if (idx === -1) return null;
  return optionValue.slice(idx + 3).trim();
}

export function flattenCurrent(product: ShopifyProduct): { variantId: number; color: string | null; colorCode: string | null; size: string | null }[] {
  const colorIdx = product.options.findIndex((o) => o.name.toLowerCase() === "color");
  const sizeIdx = product.options.findIndex((o) => o.name.toLowerCase() === "size");

  const pick = (v: ShopifyVariant, idx: number): string | null => {
    if (idx === 0) return v.option1;
    if (idx === 1) return v.option2;
    if (idx === 2) return v.option3;
    return null;
  };

  return product.variants.map((v) => {
    const color = colorIdx === -1 ? null : pick(v, colorIdx);
    const size = sizeIdx === -1 ? null : pick(v, sizeIdx);
    return { variantId: v.id, color, colorCode: parseColorCode(color), size };
  });
}

export function targetKey(colorCode: string, size: string): string {
  return `${colorCode}::${size}`;
}

interface Diff {
  toDelete: { variantId: number; color: string | null; size: string | null }[];
  toAdd: { colorName: string; colorCode: string; size: string }[];
}

export function computeDiff(
  current: { variantId: number; color: string | null; colorCode: string | null; size: string | null }[],
  target: TargetVariant[],
): Diff {
  const targetByKey = new Map(target.map((t) => [targetKey(t.colorCode, t.size), t]));
  const currentKeys = new Set(
    current.filter((c) => c.colorCode && c.size).map((c) => targetKey(c.colorCode as string, c.size as string)),
  );

  const toDelete = current.filter((c) => {
    if (!c.colorCode || !c.size) return true; // unparseable — flag for deletion review
    return !targetByKey.has(targetKey(c.colorCode, c.size));
  });

  const toAdd = target.filter((t) => !currentKeys.has(targetKey(t.colorCode, t.size)));

  return { toDelete, toAdd };
}

// Collapses a target list down to the unique Color / Size option values
// (name + linked metaobject GID) the mutation will declare. Throws if any
// target Color/Size is missing its GID — the whole point of this module is
// to never send a linked option value without one.
export function buildOptionValues(target: TargetVariant[]): {
  colorValues: OptionValueTarget[];
  sizeValues: OptionValueTarget[];
  missingGids: string[];
} {
  const colorValues: OptionValueTarget[] = [];
  const sizeValues: OptionValueTarget[] = [];
  const seenColor = new Set<string>();
  const seenSize = new Set<string>();
  const missingGids: string[] = [];

  for (const t of target) {
    const cv = colorOptionValue(t.colorName, t.colorCode);
    if (!seenColor.has(cv)) {
      seenColor.add(cv);
      if (!t.colorGid) missingGids.push(`Color ${t.colorCode} (${t.colorName}) has no shopifyGid`);
      colorValues.push({ name: cv, gid: t.colorGid ?? "" });
    }
    if (!seenSize.has(t.size)) {
      seenSize.add(t.size);
      if (!t.sizeGid) missingGids.push(`Size ${t.size} has no shopifyGid`);
      sizeValues.push({ name: t.size, gid: t.sizeGid ?? "" });
    }
  }

  return { colorValues, sizeValues, missingGids };
}

// --- Phase 1: dry diff, no writes ---

export interface DryRunResult {
  styleCode: string;
  matched: boolean;
  candidateCount: number;
  shopifyProductId: number | null;
  shopifyTitle: string | null;
  current: { variantId: number; color: string | null; size: string | null }[];
  target: TargetVariant[];
  toDelete: Diff["toDelete"];
  toAdd: Diff["toAdd"];
  colorValues: OptionValueTarget[];
  sizeValues: OptionValueTarget[];
  missingGids: string[];
  mutation: string;
  mutationVariables: unknown;
}

export async function dryRunReconcile(styleCode: string, exactTitle?: string): Promise<DryRunResult> {
  const dbResult = await getDbTarget(styleCode);
  if (!dbResult) {
    throw new Error(`No DB product found for styleCode "${styleCode}"`);
  }

  const products = await fetchAllShopifyProducts();
  const { product, candidateCount } = matchShopifyProduct(styleCode, products, exactTitle);

  const { colorValues, sizeValues, missingGids } = buildOptionValues(dbResult.target);

  if (!product) {
    return {
      styleCode,
      matched: false,
      candidateCount,
      shopifyProductId: null,
      shopifyTitle: null,
      current: [],
      target: dbResult.target,
      toDelete: [],
      toAdd: [],
      colorValues,
      sizeValues,
      missingGids,
      mutation: PRODUCT_SET_MUTATION.trim(),
      mutationVariables: null,
    };
  }

  const current = flattenCurrent(product);
  const diff = computeDiff(current, dbResult.target);
  const mutationVariables = {
    input: buildMutationInput(product.id, colorValues, sizeValues, dbResult.target),
    synchronous: dbResult.target.length <= 100,
  };

  const result: DryRunResult = {
    styleCode,
    matched: true,
    candidateCount,
    shopifyProductId: product.id,
    shopifyTitle: product.title,
    current: current.map(({ variantId, color, size }) => ({ variantId, color, size })),
    target: dbResult.target,
    toDelete: diff.toDelete,
    toAdd: diff.toAdd,
    colorValues,
    sizeValues,
    missingGids,
    mutation: PRODUCT_SET_MUTATION.trim(),
    mutationVariables,
  };

  console.log(
    `[shopify-reconcile] DRY RUN styleCode=${styleCode} product=${product.id} "${product.title}" ` +
      `current=${current.length} target=${dbResult.target.length} toDelete=${diff.toDelete.length} toAdd=${diff.toAdd.length}`,
  );

  return result;
}

// --- Phase 2: execute on one product ---

export interface ExecuteResult {
  styleCode: string;
  shopifyProductId: number;
  predicted: { toDelete: Diff["toDelete"]; toAdd: Diff["toAdd"] };
  after: { variantId: number; color: string | null; size: string | null }[];
  afterMatchesTarget: boolean;
  stillMissing: TargetVariant[]; // target combos not present after the update
  stillExtra: { variantId: number; color: string | null; size: string | null }[]; // combos present but not in target
}

export async function executeReconcile(styleCode: string, exactTitle?: string): Promise<ExecuteResult> {
  const dryRun = await dryRunReconcile(styleCode, exactTitle);
  if (!dryRun.matched || dryRun.shopifyProductId === null) {
    throw new Error(
      `Cannot execute — no unambiguous Shopify match for styleCode "${styleCode}" (candidates=${dryRun.candidateCount})`,
    );
  }

  if (dryRun.missingGids.length > 0) {
    throw new Error(
      `Cannot execute — target Color/Size values are missing shopifyGid: ${dryRun.missingGids.join("; ")}`,
    );
  }

  const { colorValues, sizeValues } = buildOptionValues(dryRun.target);

  const shopifyProductId = await setShopifyProductStructure(
    dryRun.shopifyProductId,
    colorValues,
    sizeValues,
    dryRun.target,
  );
  await sleep(CALL_PACING_MS);

  const targetByKey = new Map(dryRun.target.map((t) => [targetKey(t.colorCode, t.size), t]));

  // Large products (>100 target variants) go through productSet's async
  // ProductSetOperation path — polled to COMPLETE inside
  // setShopifyProductStructure, but a REST read immediately after can still
  // briefly lag behind that write (read-after-write consistency, not a
  // logic bug — confirmed by re-pulling the same product moments later and
  // finding it already correct). Retry the after-check a couple of times
  // with backoff before concluding anything is actually missing.
  let afterProduct = await fetchOneShopifyProduct(shopifyProductId);
  let stillMissing = dryRun.target.filter((t) => {
    const afterKeys = new Set(
      flattenCurrent(afterProduct)
        .filter((c) => c.colorCode && c.size)
        .map((c) => targetKey(c.colorCode as string, c.size as string)),
    );
    return !afterKeys.has(targetKey(t.colorCode, t.size));
  });
  let stillExtra = flattenCurrent(afterProduct).filter((c) => {
    if (!c.colorCode || !c.size) return true;
    return !targetByKey.has(targetKey(c.colorCode, c.size));
  });

  for (let attempt = 0; (stillMissing.length > 0 || stillExtra.length > 0) && attempt < 2; attempt++) {
    await sleep(2000 * (attempt + 1));
    afterProduct = await fetchOneShopifyProduct(shopifyProductId);
    stillMissing = dryRun.target.filter((t) => {
      const afterKeys = new Set(
        flattenCurrent(afterProduct)
          .filter((c) => c.colorCode && c.size)
          .map((c) => targetKey(c.colorCode as string, c.size as string)),
      );
      return !afterKeys.has(targetKey(t.colorCode, t.size));
    });
    stillExtra = flattenCurrent(afterProduct).filter((c) => {
      if (!c.colorCode || !c.size) return true;
      return !targetByKey.has(targetKey(c.colorCode, c.size));
    });
  }

  const after = flattenCurrent(afterProduct).map(({ variantId, color, size }) => ({ variantId, color, size }));

  const result: ExecuteResult = {
    styleCode,
    shopifyProductId,
    predicted: { toDelete: dryRun.toDelete, toAdd: dryRun.toAdd },
    after,
    afterMatchesTarget: stillMissing.length === 0 && stillExtra.length === 0,
    stillMissing,
    stillExtra,
  };

  console.log(
    `[shopify-reconcile] EXECUTE styleCode=${styleCode} product=${shopifyProductId} ` +
      `afterMatchesTarget=${result.afterMatchesTarget} stillMissing=${stillMissing.length} stillExtra=${stillExtra.length}`,
  );

  return result;
}

// --- Phase 3: batch across all products, resumable ---

export interface BatchLogEntry {
  styleCode: string;
  shopifyProductId: number | null;
  status: "ok" | "failed" | "unmatched" | "mismatch";
  added: number;
  removed: number;
  message?: string;
  at: string;
}

async function loadCompletedStyleCodes(): Promise<Set<string>> {
  const done = new Set<string>();
  try {
    const raw = await readFile(BATCH_LOG_PATH, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as BatchLogEntry;
        if (entry.status === "ok") done.add(entry.styleCode);
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // no log yet
  }
  return done;
}

async function appendLog(entry: BatchLogEntry): Promise<void> {
  await appendFile(BATCH_LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
}

export interface BatchReport {
  total: number;
  skippedAlreadyDone: number;
  updated: number;
  unmatched: number;
  failed: number;
  entries: BatchLogEntry[];
}

export async function batchReconcile(): Promise<BatchReport> {
  const dbProducts = await prisma.product.findMany({ select: { styleCode: true } });
  const styleCodes = [...new Set(dbProducts.map((p) => p.styleCode))];
  const completed = await loadCompletedStyleCodes();

  const report: BatchReport = { total: styleCodes.length, skippedAlreadyDone: 0, updated: 0, unmatched: 0, failed: 0, entries: [] };

  for (const styleCode of styleCodes) {
    if (completed.has(styleCode)) {
      report.skippedAlreadyDone += 1;
      continue;
    }

    try {
      const result = await executeReconcile(styleCode);
      const status: BatchLogEntry["status"] = result.afterMatchesTarget ? "ok" : "mismatch";
      const entry: BatchLogEntry = {
        styleCode,
        shopifyProductId: result.shopifyProductId,
        status,
        added: result.predicted.toAdd.length,
        removed: result.predicted.toDelete.length,
        message: result.afterMatchesTarget
          ? undefined
          : `stillMissing=${result.stillMissing.length} stillExtra=${result.stillExtra.length}`,
        at: new Date().toISOString(),
      };
      await appendLog(entry);
      report.entries.push(entry);
      if (status === "ok") report.updated += 1;
      else report.failed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isUnmatched = message.includes("no unambiguous Shopify match");
      const entry: BatchLogEntry = {
        styleCode,
        shopifyProductId: null,
        status: isUnmatched ? "unmatched" : "failed",
        added: 0,
        removed: 0,
        message,
        at: new Date().toISOString(),
      };
      await appendLog(entry);
      report.entries.push(entry);
      if (isUnmatched) report.unmatched += 1;
      else report.failed += 1;
    }

    await sleep(CALL_PACING_MS);
  }

  console.log(
    `[shopify-reconcile] BATCH complete total=${report.total} skipped=${report.skippedAlreadyDone} ` +
      `updated=${report.updated} unmatched=${report.unmatched} failed=${report.failed}`,
  );

  return report;
}

// --- Matching-integrity check: read-only survey of all products ahead of batch ---

type SizeScheme = "kids-numeric" | "adult-letter" | "mixed" | "empty";

function classifySizeScheme(sizes: string[]): SizeScheme {
  const nonEmpty = sizes.filter((s) => s.trim() !== "");
  if (nonEmpty.length === 0) return "empty";

  const isNumeric = (s: string) => /^\d+$/.test(s);
  const isLetter = (s: string) => /^(XS|S|M|L|X{0,2}L|\d+X?L)$/i.test(s);

  const numericCount = nonEmpty.filter(isNumeric).length;
  const letterCount = nonEmpty.filter(isLetter).length;

  if (numericCount === nonEmpty.length) return "kids-numeric";
  if (letterCount === nonEmpty.length) return "adult-letter";
  return "mixed";
}

export interface IntegrityFlag {
  styleCode: string;
  shopifyProductId: number | null;
  shopifyTitle: string | null;
  status: "unmatched" | "ambiguous" | "ok" | "disagreement";
  candidateCount: number;
  candidates: { id: number; title: string }[]; // populated for ambiguous matches
  currentColorCodes: string[];
  targetColorCodes: string[];
  colorMismatch: boolean;
  currentSizeScheme: SizeScheme;
  targetSizeScheme: SizeScheme;
  sizeSchemeMismatch: boolean;
  currentCount: number;
  targetCount: number;
  toDeleteCount: number;
  toAddCount: number;
  keptFraction: number; // fraction of target combos already present unchanged
  severity: "none" | "minor" | "partial" | "full-rebuild";
}

export interface IntegrityReport {
  total: number;
  unmatched: number;
  ambiguous: number;
  ok: number;
  disagreement: number;
  bySeverity: Record<string, number>;
  flags: IntegrityFlag[];
}

function classifySeverity(keptFraction: number, hasAnyDiff: boolean): IntegrityFlag["severity"] {
  if (!hasAnyDiff) return "none";
  if (keptFraction < 0.2) return "full-rebuild";
  if (keptFraction < 0.8) return "partial";
  return "minor";
}

export async function checkMatchingIntegrity(): Promise<IntegrityReport> {
  const dbProducts = await prisma.product.findMany({
    select: {
      styleCode: true,
      variants: { select: { colorCode: true, colorName: true, shopifySize: true } },
    },
  });

  const shopifyProducts = await fetchAllShopifyProducts();

  const flags: IntegrityFlag[] = [];

  for (const dbProduct of dbProducts) {
    const styleCode = dbProduct.styleCode;
    const target: TargetVariant[] = dbProduct.variants.map((v) => ({
      styleCode,
      colorCode: v.colorCode,
      colorName: v.colorName,
      colorGid: null,
      size: v.shopifySize,
      sizeGid: null,
    }));
    const targetColorCodes = [...new Set(target.map((t) => t.colorCode))].sort();
    const targetSizeScheme = classifySizeScheme(target.map((t) => t.size));

    const { product, candidateCount } = matchShopifyProduct(styleCode, shopifyProducts);

    if (!product) {
      const candidates =
        candidateCount > 0
          ? findCandidates(styleCode, shopifyProducts).map((p) => ({ id: p.id, title: p.title }))
          : [];
      flags.push({
        styleCode,
        shopifyProductId: null,
        shopifyTitle: null,
        status: candidateCount === 0 ? "unmatched" : "ambiguous",
        candidateCount,
        candidates,
        currentColorCodes: [],
        targetColorCodes,
        colorMismatch: true,
        currentSizeScheme: "empty",
        targetSizeScheme,
        sizeSchemeMismatch: true,
        currentCount: 0,
        targetCount: target.length,
        toDeleteCount: 0,
        toAddCount: target.length,
        keptFraction: 0,
        severity: "full-rebuild",
      });
      continue;
    }

    const current = flattenCurrent(product);
    const diff = computeDiff(current, target);
    const currentColorCodes = [...new Set(current.map((c) => c.colorCode).filter((c): c is string => !!c))].sort();
    const currentSizeScheme = classifySizeScheme(current.map((c) => c.size).filter((s): s is string => !!s));

    const colorMismatch = JSON.stringify(currentColorCodes) !== JSON.stringify(targetColorCodes);
    const sizeSchemeMismatch = currentSizeScheme !== targetSizeScheme;

    const keptFraction = target.length === 0 ? 1 : (target.length - diff.toAdd.length) / target.length;
    const hasAnyDiff = diff.toDelete.length > 0 || diff.toAdd.length > 0;
    const severity = classifySeverity(keptFraction, hasAnyDiff);

    flags.push({
      styleCode,
      shopifyProductId: product.id,
      shopifyTitle: product.title,
      status: hasAnyDiff ? "disagreement" : "ok",
      candidateCount,
      candidates: [],
      currentColorCodes,
      targetColorCodes,
      colorMismatch,
      currentSizeScheme,
      targetSizeScheme,
      sizeSchemeMismatch,
      currentCount: current.length,
      targetCount: target.length,
      toDeleteCount: diff.toDelete.length,
      toAddCount: diff.toAdd.length,
      keptFraction: Math.round(keptFraction * 100) / 100,
      severity,
    });
  }

  const report: IntegrityReport = {
    total: flags.length,
    unmatched: flags.filter((f) => f.status === "unmatched").length,
    ambiguous: flags.filter((f) => f.status === "ambiguous").length,
    ok: flags.filter((f) => f.status === "ok").length,
    disagreement: flags.filter((f) => f.status === "disagreement").length,
    bySeverity: {
      none: flags.filter((f) => f.severity === "none").length,
      minor: flags.filter((f) => f.severity === "minor").length,
      partial: flags.filter((f) => f.severity === "partial").length,
      "full-rebuild": flags.filter((f) => f.severity === "full-rebuild").length,
    },
    flags,
  };

  console.log(
    `[shopify-reconcile] INTEGRITY CHECK total=${report.total} ok=${report.ok} disagreement=${report.disagreement} ` +
      `unmatched=${report.unmatched} ambiguous=${report.ambiguous} full-rebuild=${report.bySeverity["full-rebuild"]}`,
  );

  return report;
}
