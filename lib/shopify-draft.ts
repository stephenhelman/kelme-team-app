/**
 * Creates ONE Shopify DRAFT product from a captured Kelme favorite, end to
 * end: re-capture -> stage + upload images -> productCreate (DRAFT) ->
 * setShopifyProductStructure (GID-linked Color/Size + variants, same path the
 * reconcile pipeline uses) -> attach one image per color -> inventory level
 * at INVENTORY_LOCATION_ID with the Kelme qty -> stamp variant ids in the
 * DB + onShopify -> re-read and verify.
 *
 * planDraft() is pure-read (DB + one Shopify title scan) and is what the
 * dry-run prints. executeDraft() is the only function here that writes
 * Shopify, and only scripts/drafts.ts --execute calls it. Kelme calls go
 * through lib/kelme.ts (DB-backed token load/persist, shared with the
 * worker); Kelme image downloads are plain unauthenticated GETs, like
 * checkImageExists.
 *
 * Resumable: a partially-built draft (right title, status DRAFT) can be
 * continued with resume=true — every step after productCreate is idempotent.
 */
import { appendFile } from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { shopifyGraphQL } from "@/lib/shopify";
import {
  buildMutationInput,
  buildOptionValues,
  getDbTarget,
  parseColorCode,
  setShopifyProductStructure,
  type OptionValueTarget,
  type TargetVariant,
} from "@/lib/shopify-reconcile";
import { executeMedia, normalizeMediaFilename } from "@/lib/shopify-media";
import { executeSizeOrder } from "@/lib/shopify-order";
import { CANONICAL_SIZE_ORDER } from "@/lib/sizes";
import {
  INVENTORY_LOCATION_ID,
  confirmLocation,
  enableTracking,
  fetchCurrentInventoryState,
  setQuantitiesWithBackoff,
} from "@/lib/shopify-inventory-push";
import { titleHasStyleCode } from "@/lib/style-match";
import { recaptureProduct, fetchShopifyTitles } from "@/lib/draft-preflight";
import { checkImageExists } from "@/lib/kelme";
import { evaluateDraft, leftOffFromNotes, type CategoryMap, type DraftEvaluation, type DraftTodo } from "@/lib/draft-rules";
import { fetchLiveCategoryMap } from "@/lib/draft-category";
import type { DraftEmailItem } from "@/lib/draft-email";
import {
  DRAFT_VENDOR,
  buildDescriptionHtml,
  planImage,
  type CategoryRule,
  type ImagePlanEntry,
} from "@/lib/shopify-draft-plan";
import { ONE_SIZE } from "@/lib/sku";
import { CORE_REQUIRES_SHIPPING, CORE_WEIGHT_LB } from "@/lib/shipping-config";
import type { AddedProduct } from "@/lib/product-added-notify";

const CALL_PACING_MS = 400;
const LOG_PATH = path.join(process.cwd(), "shopify-drafts-log.jsonl");
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DRAFT_LOG_PATH = LOG_PATH;

export async function logDraftEvent(entry: Record<string, unknown>): Promise<void> {
  await appendFile(LOG_PATH, JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n", "utf8");
}

function numericId(gid: string): number {
  return Number(gid.split("/").pop());
}

type GqlErrors = { message: string }[] | undefined;
type UserErrors = { field: string[] | null; message: string }[];

function assertOk(label: string, errors: GqlErrors, userErrors: UserErrors | undefined, payload: unknown): void {
  if (errors?.length) throw new Error(`${label} GraphQL error: ${JSON.stringify(errors)}`);
  if (!payload) throw new Error(`${label} returned no payload`);
  if (userErrors && userErrors.length > 0) throw new Error(`${label} userErrors: ${JSON.stringify(userErrors)}`);
}

// --- Plan -------------------------------------------------------------------

export interface DraftVariantPlan {
  dbVariantId: number;
  sku: string;
  colorCode: string;
  colorName: string;
  size: string;
  qty: number;
}

export interface DraftPlan {
  styleCode: string;
  pdtid: number;
  productDbId: number;
  title: string;
  vendor: string;
  status: "DRAFT";
  tags: string[];
  category: CategoryRule | null;
  descriptionHtml: string;
  price: string;
  priceSource: "kelmeCatalogPrice" | "zero (no Kelme catalog price)";
  sizeOptionName: string | null;
  colorValues: OptionValueTarget[];
  sizeValues: OptionValueTarget[];
  target: TargetVariant[];
  variants: DraftVariantPlan[];
  images: ImagePlanEntry[];
  colorsWithoutImage: string[];
  existingOnShopify: { id: string; title: string; status: string }[];
  blockers: string[];
  qtyCapturedAt: Date | null;
  todos: DraftTodo[];
  categorySource: DraftEvaluation["categorySource"];
  sizesCreated: string[];
  sizesLeftOff: string[];
  colors: { code: string; name: string }[];
  unreachableColors: string[];
}

export interface PlanDraftOptions {
  /** Categories used by live products, per Kelme sub-category (fetched once per run). */
  categoryMap?: CategoryMap;
  /** Capture warnings about policy-excluded sizes (what was left off). */
  excludedNotes?: string[];
  /** HEAD-check each color image; unreachable ones are left off and the product is tagged needs-images. */
  checkImages?: boolean;
  /** Resuming a partial draft: the DB's onShopify flag (set during the first attempt's link-back) is expected, not a blocker. */
  resume?: boolean;
}

export async function planDraft(styleCode: string, opts: PlanDraftOptions = {}): Promise<DraftPlan> {
  const product = await prisma.product.findFirst({
    where: { styleCode },
    include: { variants: { orderBy: [{ colorCode: "asc" }, { shopifySize: "asc" }] } },
  });
  if (!product) throw new Error(`No DB product found for styleCode "${styleCode}"`);

  const dbTarget = await getDbTarget(styleCode);
  if (!dbTarget) throw new Error(`No DB target for styleCode "${styleCode}"`);
  const { colorValues, sizeValues: unorderedSizes } = buildOptionValues(dbTarget.target);
  // Canonical display order (S, M, L, XL ... / 4, 6, 8 ...), not DB sort order.
  const rank = (s: string) => {
    const i = CANONICAL_SIZE_ORDER.indexOf(s);
    return i === -1 ? CANONICAL_SIZE_ORDER.length + 1 : i;
  };
  const sizeValues = [...unorderedSizes].sort((a, b) => rank(a.name) - rank(b.name));

  const [titles, categoryMap] = await Promise.all([fetchShopifyTitles(), opts.categoryMap ? Promise.resolve(opts.categoryMap) : fetchLiveCategoryMap()]);
  const existingOnShopify = titles.filter((t) => titleHasStyleCode(t.title, styleCode));

  const imagesByColor = new Map<string, ImagePlanEntry>();
  const unreachableColors: string[] = [];
  for (const colorCode of [...new Set(product.variants.map((v) => v.colorCode))]) {
    const withImage = product.variants.find((v) => v.colorCode === colorCode && v.imageUrl);
    const entry = planImage(styleCode, colorCode, withImage?.imageUrl ?? null);
    if (entry && opts.checkImages && !(await checkImageExists(entry.sourceUrl))) {
      unreachableColors.push(colorCode); // left off; the product gets needs-images
      continue;
    }
    if (entry) imagesByColor.set(colorCode, entry);
  }
  const colorsWithoutImage = [...new Set(product.variants.map((v) => v.colorCode))].filter((c) => !imagesByColor.has(c));

  const ev = evaluateDraft(
    {
      styleCode,
      name: product.name,
      gender: product.gender,
      subCategory: product.subCategory,
      kelmeCatalogPrice: product.kelmeCatalogPrice,
      variants: product.variants.map((v) => ({ colorCode: v.colorCode, colorName: v.colorName, size: v.shopifySize, qty: v.qty, imageUrl: imagesByColor.has(v.colorCode) ? v.imageUrl : null })),
      leftOff: leftOffFromNotes(opts.excludedNotes ?? []),
      unknownSizes: [], // unknown labels are caught at capture (dropNotes) and stop executeDraft
      colorsMissingGid: [...new Set(dbTarget.target.filter((t) => !t.colorGid).map((t) => t.colorCode))],
      sizesMissingGid: dbTarget.sizeOptionName === null ? [] : [...new Set(dbTarget.target.filter((t) => !t.sizeGid).map((t) => t.size))],
    },
    categoryMap,
  );
  const blockers = [...ev.blockers];
  if (product.onShopify && !opts.resume) blockers.push("DB already has onShopify=true");

  return {
    styleCode,
    pdtid: product.pdtid,
    productDbId: product.id,
    title: ev.title,
    vendor: DRAFT_VENDOR,
    status: "DRAFT",
    tags: ev.tags,
    category: ev.category,
    descriptionHtml: buildDescriptionHtml(product),
    price: ev.price,
    priceSource: product.kelmeCatalogPrice && product.kelmeCatalogPrice > 0 ? "kelmeCatalogPrice" : "zero (no Kelme catalog price)",
    sizeOptionName: dbTarget.sizeOptionName,
    colorValues,
    sizeValues,
    target: dbTarget.target,
    variants: product.variants.map((v) => ({
      dbVariantId: v.id,
      sku: v.sku,
      colorCode: v.colorCode,
      colorName: v.colorName,
      size: v.shopifySize,
      qty: v.qty,
    })),
    images: [...imagesByColor.values()],
    colorsWithoutImage,
    existingOnShopify,
    blockers,
    qtyCapturedAt: product.syncedAt,
    todos: ev.todos,
    categorySource: ev.categorySource,
    sizesCreated: ev.sizesCreated,
    sizesLeftOff: ev.sizesLeftOff,
    colors: ev.colors,
    unreachableColors,
  };
}

// The exact payloads --execute would send (productSet shown against a
// placeholder id since the real one only exists after productCreate).
export function previewMutations(plan: DraftPlan): { productCreate: unknown; productSet: unknown } {
  const priceFor = () => plan.price;
  return {
    productCreate: productCreateVariables(plan),
    productSet: buildMutationInput(0, plan.colorValues, plan.sizeValues, plan.target, plan.sizeOptionName, priceFor),
  };
}

function productCreateVariables(plan: DraftPlan) {
  const productOptions = [{ name: "Color", position: 1, values: plan.colorValues.map((v) => ({ name: v.name })) }];
  if (plan.sizeOptionName !== null) {
    productOptions.push({ name: plan.sizeOptionName, position: 2, values: plan.sizeValues.map((v) => ({ name: v.name })) });
  }
  return {
    product: {
      title: plan.title,
      vendor: plan.vendor,
      status: plan.status,
      descriptionHtml: plan.descriptionHtml,
      tags: plan.tags,
      category: plan.category?.gid,
      productOptions,
    },
  };
}

// --- Images: Kelme -> staged upload -> product media ---------------------------

const STAGED_UPLOADS_MUTATION = `
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

async function downloadKelmeImage(entry: ImagePlanEntry): Promise<Buffer> {
  const res = await fetch(entry.sourceUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`Kelme image ${entry.sourceUrl} returned HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("image/")) throw new Error(`Kelme image ${entry.sourceUrl} is not an image (content-type "${type}")`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) throw new Error(`Kelme image ${entry.sourceUrl} has unusable size ${buf.length}`);
  return buf;
}

async function stageImages(entries: ImagePlanEntry[]): Promise<Map<string, string>> {
  const resourceUrlByFilename = new Map<string, string>();
  if (entries.length === 0) return resourceUrlByFilename;

  const buffers: Buffer[] = [];
  for (const e of entries) {
    buffers.push(await downloadKelmeImage(e));
    await sleep(150);
  }

  const res = await shopifyGraphQL<{
    stagedUploadsCreate: {
      stagedTargets: { url: string; resourceUrl: string; parameters: { name: string; value: string }[] }[];
      userErrors: UserErrors;
    };
  }>(STAGED_UPLOADS_MUTATION, {
    input: entries.map((e, i) => ({
      resource: "IMAGE",
      filename: e.filename,
      mimeType: e.mimeType,
      httpMethod: "POST",
      fileSize: String(buffers[i].length),
    })),
  });
  assertOk("stagedUploadsCreate", res.errors, res.data?.stagedUploadsCreate.userErrors, res.data?.stagedUploadsCreate);
  const targets = res.data!.stagedUploadsCreate.stagedTargets;
  if (targets.length !== entries.length) throw new Error(`stagedUploadsCreate returned ${targets.length} targets for ${entries.length} images`);

  for (let i = 0; i < entries.length; i++) {
    const form = new FormData();
    for (const p of targets[i].parameters) form.append(p.name, p.value);
    form.append("file", new Blob([new Uint8Array(buffers[i])], { type: entries[i].mimeType }), entries[i].filename);
    const up = await fetch(targets[i].url, { method: "POST", body: form });
    if (!up.ok) throw new Error(`staged upload of ${entries[i].filename} failed: HTTP ${up.status} ${(await up.text()).slice(0, 300)}`);
    resourceUrlByFilename.set(entries[i].filename, targets[i].resourceUrl);
    await sleep(150);
  }
  return resourceUrlByFilename;
}

const PRODUCT_MEDIA_QUERY = `
  query draftMedia($id: ID!) {
    product(id: $id) {
      media(first: 250) { nodes { id status ... on MediaImage { image { url } } } }
    }
  }
`;

interface MediaNode {
  id: string;
  status: string;
  image: { url: string } | null;
}

async function fetchMedia(productGid: string): Promise<MediaNode[]> {
  const res = await shopifyGraphQL<{ product: { media: { nodes: MediaNode[] } } | null }>(PRODUCT_MEDIA_QUERY, { id: productGid });
  if (res.errors?.length) throw new Error(`product media query error: ${JSON.stringify(res.errors)}`);
  if (!res.data?.product) throw new Error(`product ${productGid} not found`);
  return res.data.product.media.nodes;
}

// Media is processed asynchronously; the image URL (and so the filename the
// variant-attach step matches on) only exists once READY.
async function waitForMediaReady(productGid: string, expected: number): Promise<MediaNode[]> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const media = await fetchMedia(productGid);
    const failed = media.filter((m) => m.status === "FAILED");
    if (failed.length > 0) throw new Error(`${failed.length} media item(s) FAILED processing on ${productGid}`);
    if (media.length >= expected && media.every((m) => m.status === "READY" && m.image)) return media;
    await sleep(1500);
  }
  throw new Error(`media on ${productGid} not READY after polling (expected ${expected})`);
}

// Compared without Shopify's de-duplication UUID, so a resume never re-uploads an image it already has.
function filenameOf(url: string | undefined): string {
  return normalizeMediaFilename(url ?? "");
}

const PRODUCT_ATTACH_MEDIA_MUTATION = `
  mutation draftAttachMedia($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
    productUpdate(product: $product, media: $media) {
      product { id }
      userErrors { field message }
    }
  }
`;

// Uploads + attaches only the images whose filename isn't already on the
// product, so a resume never duplicates media.
async function ensureProductMedia(productGid: string, plan: DraftPlan): Promise<number> {
  const existing = await fetchMedia(productGid);
  if (existing.some((m) => m.status !== "READY")) await waitForMediaReady(productGid, existing.length);
  const have = new Set((await fetchMedia(productGid)).map((m) => filenameOf(m.image?.url)));
  const missing = plan.images.filter((i) => !have.has(i.filename));
  if (missing.length === 0) return 0;

  const staged = await stageImages(missing);
  const res = await shopifyGraphQL<{ productUpdate: { product: { id: string } | null; userErrors: UserErrors } }>(
    PRODUCT_ATTACH_MEDIA_MUTATION,
    {
      product: { id: productGid },
      media: missing.map((i) => ({
        originalSource: staged.get(i.filename),
        mediaContentType: "IMAGE",
        alt: `${plan.title} - ${plan.variants.find((v) => v.colorCode === i.colorCode)?.colorName ?? i.colorCode}`,
      })),
    },
  );
  assertOk("productUpdate (media)", res.errors, res.data?.productUpdate.userErrors, res.data?.productUpdate);
  return missing.length;
}

// --- Variants read-back ---------------------------------------------------------

const VARIANTS_QUERY = `
  query draftVariants($id: ID!) {
    product(id: $id) {
      variants(first: 250) {
        nodes {
          id
          sku
          price
          selectedOptions { name value }
          inventoryItem { id tracked requiresShipping measurement { weight { value unit } } }
          media(first: 2) { nodes { id } }
        }
      }
    }
  }
`;

export interface VariantNode {
  id: string;
  sku: string | null;
  price: string;
  selectedOptions: { name: string; value: string }[];
  inventoryItem: { id: string; tracked: boolean; requiresShipping: boolean; measurement: { weight: { value: number; unit: string } | null } } | null;
  media: { nodes: { id: string }[] };
}

export async function fetchVariants(productGid: string): Promise<VariantNode[]> {
  const res = await shopifyGraphQL<{ product: { variants: { nodes: VariantNode[] } } | null }>(VARIANTS_QUERY, { id: productGid });
  if (res.errors?.length) throw new Error(`variants query error: ${JSON.stringify(res.errors)}`);
  if (!res.data?.product) throw new Error(`product ${productGid} not found`);
  return res.data.product.variants.nodes;
}

const LB_PER_UNIT: Record<string, number> = { POUNDS: 1, OUNCES: 1 / 16, KILOGRAMS: 2.2046226218, GRAMS: 0.0022046226218 };

/** Weight normalised to pounds (rounded to 4dp); null when unset or an unknown unit. */
export function weightInLb(w: { value: number; unit: string } | null): number | null {
  if (!w || !(w.unit in LB_PER_UNIT)) return null;
  return Math.round(w.value * LB_PER_UNIT[w.unit] * 10000) / 10000;
}

// (colorCode, size) identity — never SKU alone, same rule as lib/shopify-relink.ts.
export function variantKey(v: VariantNode): string {
  const color = v.selectedOptions.find((o) => o.name === "Color")?.value ?? null;
  const size = v.selectedOptions.find((o) => o.name === "Size" || o.name === "Ball size")?.value ?? ONE_SIZE;
  return `${parseColorCode(color) ?? "?"}::${size}`;
}

// --- Inventory ---------------------------------------------------------------------

const ACTIVATE_MUTATION = `
  mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!, $available: Int, $key: String!) {
    inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) @idempotent(key: $key) {
      inventoryLevel { id }
      userErrors { field message }
    }
  }
`;

function idemKey(...parts: (string | number)[]): string {
  const h = createHash("sha256").update(parts.join("|")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Makes every item tracked, stocked at INVENTORY_LOCATION_ID, with on_hand =
// the Kelme qty. Idempotent: items already correct are left alone.
async function ensureInventory(items: { inventoryItemGid: string; qty: number }[]): Promise<void> {
  const state = await fetchCurrentInventoryState(items.map((i) => i.inventoryItemGid));
  for (const item of items) {
    const s = state.get(item.inventoryItemGid);
    if (!s) throw new Error(`inventory item ${item.inventoryItemGid} not found`);
    if (!s.tracked) {
      await enableTracking(item.inventoryItemGid);
      await sleep(CALL_PACING_MS);
    }
    if (s.currentOnHand === null) {
      const res = await shopifyGraphQL<{ inventoryActivate: { inventoryLevel: { id: string } | null; userErrors: UserErrors } }>(ACTIVATE_MUTATION, {
        inventoryItemId: item.inventoryItemGid,
        locationId: INVENTORY_LOCATION_ID,
        available: item.qty,
        key: idemKey("activate", item.inventoryItemGid, INVENTORY_LOCATION_ID, item.qty),
      });
      assertOk("inventoryActivate", res.errors, res.data?.inventoryActivate.userErrors, res.data?.inventoryActivate);
      await sleep(CALL_PACING_MS);
    } else if (s.currentOnHand !== item.qty) {
      const { staleIndexes } = await setQuantitiesWithBackoff(
        [{ inventoryItemId: item.inventoryItemGid, locationId: INVENTORY_LOCATION_ID, quantity: item.qty, changeFromQuantity: s.currentOnHand }],
        `draft:${item.inventoryItemGid}:${item.qty}`,
      );
      if (staleIndexes.length > 0) throw new Error(`inventory CAS conflict on ${item.inventoryItemGid}`);
      await sleep(CALL_PACING_MS);
    }
  }
}

// --- Execute -----------------------------------------------------------------------

const PRODUCT_CREATE_MUTATION = `
  mutation productCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id title status }
      userErrors { field message }
    }
  }
`;

export interface VerifyReport {
  productId: string;
  status: string;
  vendor: string;
  title: string;
  tags: string[];
  category: string | null;
  options: { name: string; linkedKey: string | null; values: number }[];
  variantCount: number;
  expectedVariantCount: number;
  imagesAttached: number;
  expectedImages: number;
  variantsWithMedia: number;
  perVariant: { colorCode: string; sku: string; price: string; tracked: boolean; onHand: number | null; expectedQty: number; hasMedia: boolean; weightLb: number | null; requiresShipping: boolean | null }[];
  problems: string[];
}

const VERIFY_QUERY = `
  query draftVerify($id: ID!) {
    product(id: $id) {
      id title status vendor tags
      category { fullName }
      options { name linkedMetafield { key } optionValues { id } }
      mediaCount { count }
    }
  }
`;

export async function verifyDraft(productGid: string, plan: DraftPlan): Promise<VerifyReport> {
  const res = await shopifyGraphQL<{
    product: {
      id: string;
      title: string;
      status: string;
      vendor: string;
      tags: string[];
      category: { fullName: string } | null;
      options: { name: string; linkedMetafield: { key: string } | null; optionValues: { id: string }[] }[];
      mediaCount: { count: number };
    } | null;
  }>(VERIFY_QUERY, { id: productGid });
  if (res.errors?.length) throw new Error(`verify query error: ${JSON.stringify(res.errors)}`);
  const p = res.data?.product;
  if (!p) throw new Error(`product ${productGid} not found on re-read`);

  const variants = await fetchVariants(productGid);
  const state = await fetchCurrentInventoryState(variants.flatMap((v) => (v.inventoryItem ? [v.inventoryItem.id] : [])));
  const qtyByKey = new Map(plan.variants.map((v) => [`${v.colorCode}::${v.size}`, v.qty]));

  const colorsWithPlannedImage = new Set(plan.images.map((i) => i.colorCode));
  const perVariant = variants.map((v) => {
    const st = v.inventoryItem ? state.get(v.inventoryItem.id) : undefined;
    return {
      colorCode: variantKey(v).split("::")[0],
      sku: v.sku ?? "(none)",
      price: v.price,
      tracked: Boolean(v.inventoryItem?.tracked),
      onHand: st?.currentOnHand ?? null,
      expectedQty: qtyByKey.get(variantKey(v)) ?? -1,
      hasMedia: v.media.nodes.length > 0,
      weightLb: weightInLb(v.inventoryItem?.measurement.weight ?? null),
      requiresShipping: v.inventoryItem?.requiresShipping ?? null,
    };
  });

  const problems: string[] = [];
  if (p.status !== "DRAFT") problems.push(`status is ${p.status}, expected DRAFT`);
  if (p.vendor !== plan.vendor) problems.push(`vendor is "${p.vendor}"`);
  if (p.title !== plan.title) problems.push(`title is "${p.title}"`);
  for (const t of plan.tags) if (!p.tags.some((x) => x.toLowerCase() === t.toLowerCase())) problems.push(`missing tag "${t}"`);
  if (plan.category && p.category?.fullName !== plan.category.label) problems.push(`category is "${p.category?.fullName}", expected "${plan.category.label}"`);
  const expectedLinked: Record<string, string> = { Color: "color-pattern", Size: "size", "Ball size": "ball-size" };
  for (const o of p.options) {
    if (expectedLinked[o.name] && o.linkedMetafield?.key !== expectedLinked[o.name]) problems.push(`option ${o.name} not linked to ${expectedLinked[o.name]}`);
  }
  if (variants.length !== plan.variants.length) problems.push(`variant count ${variants.length} != expected ${plan.variants.length}`);
  for (const v of perVariant) {
    if (!v.tracked) problems.push(`${v.sku}: inventory not tracked`);
    if (v.onHand === null) problems.push(`${v.sku}: no inventory level at ${INVENTORY_LOCATION_ID}`);
    else if (v.onHand !== v.expectedQty) problems.push(`${v.sku}: on_hand ${v.onHand} != Kelme qty ${v.expectedQty}`);
    if (v.price !== plan.price) problems.push(`${v.sku}: price ${v.price} != ${plan.price}`);
    if (v.weightLb !== CORE_WEIGHT_LB) problems.push(`${v.sku}: weight ${v.weightLb ?? "none"} lb != ${CORE_WEIGHT_LB} lb`);
    if (v.requiresShipping !== CORE_REQUIRES_SHIPPING) problems.push(`${v.sku}: requiresShipping ${v.requiresShipping} != ${CORE_REQUIRES_SHIPPING}`);
    // A color with no image is allowed (the draft is tagged needs-images); a color that HAD one must show it.
    if (!v.hasMedia && colorsWithPlannedImage.has(v.colorCode)) problems.push(`${v.sku}: no image attached`);
  }

  return {
    productId: p.id,
    status: p.status,
    vendor: p.vendor,
    title: p.title,
    tags: p.tags,
    category: p.category?.fullName ?? null,
    options: p.options.map((o) => ({ name: o.name, linkedKey: o.linkedMetafield?.key ?? null, values: o.optionValues.length })),
    variantCount: variants.length,
    expectedVariantCount: plan.variants.length,
    imagesAttached: p.mediaCount.count,
    expectedImages: plan.images.length,
    variantsWithMedia: perVariant.filter((v) => v.hasMedia).length,
    perVariant,
    problems,
  };
}

export interface ExecuteDraftResult {
  productId: string;
  createdNew: boolean;
  mediaUploaded: number;
  verify: VerifyReport;
  summary: AddedProduct;
  emailItem: DraftEmailItem;
}

/** Thrown after productCreate succeeded: a partial draft exists and the style needs a human `--resume`. */
export class PartialDraftError extends Error {
  constructor(message: string, readonly productGid: string) {
    super(message);
    this.name = "PartialDraftError";
  }
}

export async function executeDraft(styleCode: string, opts: { resume?: boolean; categoryMap?: CategoryMap } = {}): Promise<ExecuteDraftResult> {
  const resume = opts.resume === true;

  // 0. Guards that need no Shopify write.
  const location = await confirmLocation();
  if (!location.found || !location.matchesExpectedAddress || location.isActive === false) {
    throw new Error(`Inventory location ${INVENTORY_LOCATION_ID} failed confirmation: ${JSON.stringify(location)}`);
  }

  // 1. Fresh Kelme state (current qty, current sizes) before anything is sent.
  const row = await prisma.product.findFirst({ where: { styleCode }, select: { id: true, pdtid: true } });
  if (!row) throw new Error(`No DB product found for styleCode "${styleCode}"`);
  const recap = await recaptureProduct({ id: row.id, pdtid: row.pdtid, styleCode });
  if (recap.error) throw new Error(`Kelme re-capture failed: ${recap.error}`);
  if (recap.dropNotes.length > 0) throw new Error(`Cannot execute — Kelme re-capture dropped sizes, not a clean product: ${recap.dropNotes.join("; ")}`);

  const plan = await planDraft(styleCode, { categoryMap: opts.categoryMap, excludedNotes: recap.excludedNotes, checkImages: true, resume });
  if (plan.blockers.length > 0) throw new Error(`Cannot execute — ${plan.blockers.join("; ")}`);

  // 2. productCreate (or adopt the partial draft on --resume).
  let productGid: string;
  let createdNew = false;
  if (plan.existingOnShopify.length > 0) {
    const [only, ...rest] = plan.existingOnShopify;
    if (!resume) {
      throw new Error(`Cannot execute — a Shopify product already carries this style code: ${plan.existingOnShopify.map((e) => `${e.id} [${e.status}] "${e.title}"`).join("; ")} (use --resume to continue a partial draft)`);
    }
    if (rest.length > 0 || only.status !== "DRAFT" || only.title !== plan.title) {
      throw new Error(`Cannot resume — expected exactly one DRAFT titled "${plan.title}", found: ${JSON.stringify(plan.existingOnShopify)}`);
    }
    productGid = only.id;
    await logDraftEvent({ styleCode, step: "resume", productGid });
  } else {
    if (resume) throw new Error("Cannot resume — no existing draft found for this style code");
    const res = await shopifyGraphQL<{ productCreate: { product: { id: string } | null; userErrors: UserErrors } }>(
      PRODUCT_CREATE_MUTATION,
      productCreateVariables(plan),
    );
    assertOk("productCreate", res.errors, res.data?.productCreate.userErrors, res.data?.productCreate.product);
    productGid = res.data!.productCreate.product!.id;
    createdNew = true;
    await logDraftEvent({ styleCode, step: "productCreate", productGid });
    await sleep(CALL_PACING_MS);
  }
  const productNumericId = numericId(productGid);
  try {
  
    // 3. Options + variants through the existing GID-linked path.
    await setShopifyProductStructure(productNumericId, plan.colorValues, plan.sizeValues, plan.target, plan.sizeOptionName, () => plan.price);
    await logDraftEvent({ styleCode, step: "structure", productGid, variants: plan.target.length });
    await sleep(CALL_PACING_MS);
    if (plan.sizeOptionName !== null) {
      await executeSizeOrder(productNumericId);
      await sleep(CALL_PACING_MS);
    }

    // 4. Images (only when Kelme supplied some): upload + attach to the product, then one per color to variants.
    let mediaUploaded = 0;
    if (plan.images.length > 0) {
      mediaUploaded = await ensureProductMedia(productGid, plan);
      await waitForMediaReady(productGid, plan.images.length);
      await executeMedia(productNumericId);
    }
    await logDraftEvent({ styleCode, step: "media", productGid, uploaded: mediaUploaded, images: plan.images.length });

    // 5. Link-back: stamp variant + inventory-item ids in the DB.
    const live = await fetchVariants(productGid);
    const byKey = new Map(live.map((v) => [variantKey(v), v]));
    const items: { inventoryItemGid: string; qty: number }[] = [];
    for (const v of plan.variants) {
      const lv = byKey.get(`${v.colorCode}::${v.size}`);
      if (!lv || !lv.inventoryItem) throw new Error(`no Shopify variant/inventory item for ${v.sku} (${v.colorCode}::${v.size})`);
      await prisma.variant.update({
        where: { id: v.dbVariantId },
        data: { shopifyVariantId: lv.id, shopifyInventoryItemId: lv.inventoryItem.id },
      });
      items.push({ inventoryItemGid: lv.inventoryItem.id, qty: v.qty });
    }
    await prisma.product.update({ where: { id: plan.productDbId }, data: { onShopify: true } });
    await logDraftEvent({ styleCode, step: "linkback", productGid, variants: items.length });

    // 6. Inventory level at the store location with the Kelme qty.
    await ensureInventory(items);
    await logDraftEvent({ styleCode, step: "inventory", productGid, items: items.length });

    // 7. Re-read everything from Shopify.
    const verify = await verifyDraft(productGid, plan);
    await logDraftEvent({ styleCode, step: "verify", productGid, problems: verify.problems });
    const summary: AddedProduct = {
      title: plan.title,
      styleCode: plan.styleCode,
      shopifyProductId: productGid,
      status: verify.status,
      category: verify.category,
      variantCount: verify.variantCount,
      colorCount: plan.colorValues.length,
      sizes: plan.sizeValues.map((v) => v.name),
      imagesAttached: verify.imagesAttached,
      totalQty: plan.variants.reduce((n, v) => n + v.qty, 0),
      variantsInStock: plan.variants.filter((v) => v.qty > 0).length,
      price: plan.price,
      needsPricing: plan.tags.includes("needs-pricing"),
    };
    const emailItem: DraftEmailItem = {
      title: plan.title,
      styleCode: plan.styleCode,
      shopifyProductId: productGid,
      colors: plan.colors.map((c) => c.name),
      sizes: plan.sizesCreated,
      sizesNotOffered: plan.sizesLeftOff,
      todos: plan.todos,
    };
    return { productId: productGid, createdNew, mediaUploaded, verify, summary, emailItem };
  } catch (err) {
    // Everything after productCreate is idempotent, so a failure here leaves a partial DRAFT that --resume can finish.
    throw new PartialDraftError(err instanceof Error ? err.message : String(err), productGid);
  }
}
