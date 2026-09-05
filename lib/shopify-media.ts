/**
 * Re-links a product's EXISTING media to its variants by color, using the
 * {style}_{colorCode}_{seq}.ext filename convention. Never uploads or
 * deletes media — this only re-attaches product media that already
 * survived a productSet variant recreation, which orphans the old
 * variant<->media links (new variant IDs).
 *
 * Only the front (lowest seq, typically _01) image per color is attached —
 * this API version allows exactly ONE attached media item per variant; a
 * second attach attempt on the same variant is rejected ("The given
 * variant already has attached media"), confirmed empirically. Back shots
 * stay in the product's general media gallery, just not variant-scoped.
 */
import { shopifyGraphQL } from "@/lib/shopify";

function shopifyProductGid(id: number): string {
  return `gid://shopify/Product/${id}`;
}

interface MediaNode {
  id: string;
  image: { url: string } | null;
}
interface VariantNode {
  id: string;
  title: string;
  media: { edges: { node: { id: string } }[] };
}

const QUERY = `
  query productMediaPlan($id: ID!) {
    product(id: $id) {
      media(first: 100) { edges { node { id ... on MediaImage { image { url } } } } }
      variants(first: 100) { edges { node { id title media(first: 5) { edges { node { id } } } } } }
    }
  }
`;

const APPEND_MUTATION = `
  mutation productVariantAppendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
    productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
      userErrors { field message }
    }
  }
`;

function parseFilename(url: string): { code: string; seq: string } | null {
  const fname = url.split("/").pop()?.split("?")[0] ?? "";
  const m = fname.match(/^.+?_(\w+)_(\d+)\.\w+$/);
  return m ? { code: m[1], seq: m[2] } : null;
}

async function fetchPlanData(shopifyProductId: number) {
  const res = await shopifyGraphQL<{
    product: { media: { edges: { node: MediaNode }[] }; variants: { edges: { node: VariantNode }[] } } | null;
  }>(QUERY, { id: shopifyProductGid(shopifyProductId) });
  if (res.errors?.length) throw new Error(`product media/variants query error: ${JSON.stringify(res.errors)}`);
  const product = res.data?.product;
  if (!product) throw new Error(`product ${shopifyProductId} not found`);

  const mediaByCode = new Map<string, { seq: string; id: string }[]>();
  for (const { node } of product.media.edges) {
    const url = node.image?.url;
    if (!url) continue;
    const parsed = parseFilename(url);
    if (!parsed) continue;
    if (!mediaByCode.has(parsed.code)) mediaByCode.set(parsed.code, []);
    mediaByCode.get(parsed.code)!.push({ seq: parsed.seq, id: node.id });
  }
  for (const arr of mediaByCode.values()) arr.sort((a, b) => a.seq.localeCompare(b.seq));

  return { product, mediaByCode };
}

export interface MediaPlanEntry {
  variantId: string;
  variantTitle: string;
  colorCode: string | null;
  targetMediaId: string | null; // null = no image available for this color
  currentlyHasMedia: boolean;
}

export interface MediaPlan {
  shopifyProductId: number;
  entries: MediaPlanEntry[];
  toAttachCount: number;
  alreadyAttachedCount: number;
  noMediaForColorCount: number;
}

export async function planMedia(shopifyProductId: number): Promise<MediaPlan> {
  const { product, mediaByCode } = await fetchPlanData(shopifyProductId);

  const entries: MediaPlanEntry[] = product.variants.edges.map(({ node: v }) => {
    const colorPart = v.title.split(" / ")[0] ?? "";
    const colorCode = colorPart.includes(" - ") ? (colorPart.split(" - ").pop() ?? null) : null;
    const images = colorCode ? mediaByCode.get(colorCode) : undefined;
    return {
      variantId: v.id,
      variantTitle: v.title,
      colorCode,
      targetMediaId: images?.[0]?.id ?? null,
      currentlyHasMedia: v.media.edges.length > 0,
    };
  });

  return {
    shopifyProductId,
    entries,
    toAttachCount: entries.filter((e) => e.targetMediaId && !e.currentlyHasMedia).length,
    alreadyAttachedCount: entries.filter((e) => e.currentlyHasMedia).length,
    noMediaForColorCount: entries.filter((e) => !e.targetMediaId).length,
  };
}

export interface MediaExecuteResult {
  shopifyProductId: number;
  attachedCount: number;
  afterWithMedia: number;
  afterTotal: number;
}

export async function executeMedia(shopifyProductId: number): Promise<MediaExecuteResult> {
  const plan = await planMedia(shopifyProductId);
  const toSend = plan.entries.filter((e) => e.targetMediaId && !e.currentlyHasMedia);

  if (toSend.length > 0) {
    const variantMedia = toSend.map((e) => ({ variantId: e.variantId, mediaIds: [e.targetMediaId as string] }));
    const res = await shopifyGraphQL<{ productVariantAppendMedia: { userErrors: { field: string[] | null; message: string }[] } }>(
      APPEND_MUTATION,
      { productId: shopifyProductGid(shopifyProductId), variantMedia },
    );
    if (res.errors?.length) throw new Error(`productVariantAppendMedia GraphQL error: ${JSON.stringify(res.errors)}`);
    const userErrors = res.data?.productVariantAppendMedia.userErrors ?? [];
    if (userErrors.length > 0) throw new Error(`productVariantAppendMedia userErrors: ${JSON.stringify(userErrors)}`);
  }

  const { product } = await fetchPlanData(shopifyProductId);
  const afterWithMedia = product.variants.edges.filter(({ node }) => node.media.edges.length > 0).length;

  return {
    shopifyProductId,
    attachedCount: toSend.length,
    afterWithMedia,
    afterTotal: product.variants.edges.length,
  };
}
