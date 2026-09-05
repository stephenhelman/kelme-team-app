/**
 * Derives the Kids/Adults age tag from a product's DB name and reconciles
 * it against the Shopify product's current tags, keyed by styleCode. Tags
 * only — never touches options, variants, or media (see
 * lib/shopify-reconcile.ts for that).
 *
 * Two gated entry points, meant to be run in order with human review
 * between each:
 *   - dryRunTags  — read-only. Shows current tags -> target tags -> diff.
 *   - executeTags — writes tags for ONE product, re-pulls, confirms.
 *
 * Classification rule (from the DB Product.name, e.g. "Training Jacket
 * (Kids)" / "T-Shirt (Adults)" / "Polo Shirt - Men's"):
 *   - "Kids" in the name            -> Kids
 *   - "Adults"/"Men"/"Men's"/
 *     "Women"/"Women's" in the name -> Adults
 *   - both, or neither              -> ambiguous, flagged for manual
 *                                      review, never auto-tagged
 *
 * All non-age tags (category tags like "Backpacks", "Soccer Uniform") are
 * preserved untouched — only the Kids/Adults pair is added, removed, or
 * left as-is.
 */
import { appendFile, readFile } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { shopifyAdminFetch, shopifyGraphQL, parseNextPageUrl } from "@/lib/shopify";

const CALL_PACING_MS = 400;
const BATCH_LOG_PATH = path.join(process.cwd(), "shopify-tags-log.jsonl");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Shopify REST shapes (tags only — no options/variants needed here) ---

interface ShopifyProduct {
  id: number;
  title: string;
  tags: string;
}

async function fetchAllShopifyProducts(): Promise<ShopifyProduct[]> {
  const products: ShopifyProduct[] = [];
  let nextUrl: string | null = "/products.json?limit=250";

  while (nextUrl) {
    const res = await shopifyAdminFetch(nextUrl);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify request failed: HTTP ${res.status} ${body}`);
    }
    const json = (await res.json()) as { products: ShopifyProduct[] };
    products.push(...json.products);

    nextUrl = parseNextPageUrl(res.headers.get("Link"));
    if (nextUrl) await sleep(CALL_PACING_MS);
  }

  console.log(`[shopify-tags] pulled ${products.length} products`);
  return products;
}

// --- Matching Shopify products to DB products by styleCode (same
// whole-word-boundary approach as lib/shopify-reconcile.ts) ---

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

// --- Audience classification ---
//
// Three signals, in priority order:
//
// 1. Title (DB Product.name) — an explicit "Kids"/"Adults"/"Men"/"Women"
//    in the name always wins, even over Gender/Sub-category. This is what
//    catches "Backpack (Kids)" / "Backpack (Adults)" — real audience-
//    specific merchandise that happens to share an equipment sub-category
//    with generic, audience-less versions of the same product.
//
// 2. Sub-category equipment override — checked before Gender because
//    Kelme's Gender field is inconsistent for equipment: "Training Device"
//    items get Gender "Undefined", but "Football Ball"/"Bagpack"/"Ball
//    Bag"/"Captain Armband"/"Trolley Case" items get "Unisex" instead —
//    same "no real audience" reality, two different literal values, and
//    "Unisex" would otherwise map to Adults. Confirmed against the full
//    catalog: 58 of 63 "Unisex" products are equipment by sub-category
//    (balls, backpacks, cones, poles, armbands, agility kits), not apparel.
//
// 3. Product.gender, pulled from Kelme's b2b.pdt.detail endpoint
//    (lib/kelme-attributes.ts) — a controlled, 5-value vocabulary confirmed
//    against the full live catalog (313/313 products, 0 blanks):
//      Men, Women, Unisex -> adults
//      Boys, Girls (not observed yet, same pattern as Boys) -> kids
//      Undefined -> ambiguous (equipment, no audience)
//
// Anything that clears all three with no answer is genuinely ambiguous —
// never silently guessed.

export type Audience = "kids" | "adults" | "ambiguous";

const GENDER_TO_AUDIENCE: Record<string, Audience> = {
  men: "adults",
  women: "adults",
  unisex: "adults",
  boys: "kids",
  girls: "kids",
  undefined: "ambiguous",
};

// Sub-category values confirmed (via the full catalog) to be equipment/
// accessories with no real audience, regardless of what Gender says.
const EQUIPMENT_SUBCATEGORIES = new Set([
  "football ball",
  "training device",
  "bagpack",
  "ball bag",
  "captain armband",
  "trolley case",
]);

const KIDS_RE = /\bkids\b/i;
const ADULTS_RE = /\badults?\b/i;
// Covers Men/Men's/Mens/Women/Women's/Man/Woman in one pattern — the
// apostrophe in "Men's" is a non-word character, so \bmen\b already matches
// the "Men" token inside it; no separate apostrophe-aware pattern needed.
const GENDER_ADULT_RE = /\b(men|women|man|woman)\b/i;

function classifyFromTitle(name: string): Audience {
  const hasKids = KIDS_RE.test(name);
  const hasAdults = ADULTS_RE.test(name) || GENDER_ADULT_RE.test(name);
  if (hasKids && hasAdults) return "ambiguous";
  if (hasKids) return "kids";
  if (hasAdults) return "adults";
  return "ambiguous";
}

export function classifyAudience(name: string, gender?: string | null, subCategory?: string | null): Audience {
  const titleResult = classifyFromTitle(name);
  if (titleResult !== "ambiguous") return titleResult;

  if (subCategory && EQUIPMENT_SUBCATEGORIES.has(subCategory.trim().toLowerCase())) {
    return "ambiguous";
  }

  if (gender) {
    const mapped = GENDER_TO_AUDIENCE[gender.trim().toLowerCase()];
    if (mapped) return mapped;
  }

  return "ambiguous";
}

// --- Tag target computation ---

const AGE_TAG_RE = /^(kids|adults)$/i;

function computeTargetTags(currentTags: string[], audience: "kids" | "adults"): string[] {
  const nonAgeTags = currentTags.filter((t) => !AGE_TAG_RE.test(t));
  const ageTag = audience === "kids" ? "Kids" : "Adults";
  return [ageTag, ...nonAgeTags];
}

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function tagSetsEqual(a: string[], b: string[]): boolean {
  const na = new Set(a.map((t) => t.toLowerCase()));
  const nb = new Set(b.map((t) => t.toLowerCase()));
  if (na.size !== nb.size) return false;
  for (const t of na) if (!nb.has(t)) return false;
  return true;
}

function diffTags(current: string[], target: string[]): { toAdd: string[]; toRemove: string[] } {
  const currentLower = new Set(current.map((t) => t.toLowerCase()));
  const targetLower = new Set(target.map((t) => t.toLowerCase()));
  return {
    toAdd: target.filter((t) => !currentLower.has(t.toLowerCase())),
    toRemove: current.filter((t) => !targetLower.has(t.toLowerCase())),
  };
}

// --- GraphQL productUpdate: full tag-array replace ---

const PRODUCT_UPDATE_MUTATION = `
  mutation productUpdate($input: ProductUpdateInput!) {
    productUpdate(product: $input) {
      product { id tags }
      userErrors { field message }
    }
  }
`;

interface ProductUpdateResponse {
  productUpdate: {
    product: { id: string; tags: string[] } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

function shopifyProductGid(id: number): string {
  return `gid://shopify/Product/${id}`;
}

// --- Phase 1: dry diff, no writes ---

export interface DryRunTagsResult {
  styleCode: string;
  dbName: string | null;
  audience: Audience;
  matched: boolean;
  candidateCount: number;
  shopifyProductId: number | null;
  shopifyTitle: string | null;
  currentTags: string[];
  targetTags: string[];
  toAdd: string[];
  toRemove: string[];
  flagged: boolean;
  flagReason: string | null;
}

export async function dryRunTags(styleCode: string, exactTitle?: string): Promise<DryRunTagsResult> {
  const dbProduct = await prisma.product.findFirst({
    where: { styleCode },
    select: { name: true, gender: true, subCategory: true },
  });
  if (!dbProduct) {
    throw new Error(`No DB product found for styleCode "${styleCode}"`);
  }

  const audience = classifyAudience(dbProduct.name, dbProduct.gender, dbProduct.subCategory);
  const usedGender = dbProduct.gender && GENDER_TO_AUDIENCE[dbProduct.gender.trim().toLowerCase()];
  const isEquipmentSubCategory = Boolean(
    dbProduct.subCategory && EQUIPMENT_SUBCATEGORIES.has(dbProduct.subCategory.trim().toLowerCase()),
  );

  const products = await fetchAllShopifyProducts();
  const { product, candidateCount } = matchShopifyProduct(styleCode, products, exactTitle);

  if (!product) {
    return {
      styleCode,
      dbName: dbProduct.name,
      audience,
      matched: false,
      candidateCount,
      shopifyProductId: null,
      shopifyTitle: null,
      currentTags: [],
      targetTags: [],
      toAdd: [],
      toRemove: [],
      flagged: true,
      flagReason: `no unambiguous Shopify match (candidates=${candidateCount})`,
    };
  }

  const currentTags = parseTags(product.tags);

  if (audience === "ambiguous") {
    const flagReason = isEquipmentSubCategory
      ? `Sub-category "${dbProduct.subCategory}" is equipment/accessory (Gender="${dbProduct.gender}" ignored) — not auto-tagged`
      : dbProduct.gender?.trim().toLowerCase() === "undefined"
        ? `Gender attribute is "Undefined" (equipment/accessory, no audience) — not auto-tagged`
        : `title "${dbProduct.name}" doesn't clearly indicate Kids vs Adults (no usable Gender attribute either) — not auto-tagged`;
    const result: DryRunTagsResult = {
      styleCode,
      dbName: dbProduct.name,
      audience,
      matched: true,
      candidateCount,
      shopifyProductId: product.id,
      shopifyTitle: product.title,
      currentTags,
      targetTags: currentTags, // no change proposed
      toAdd: [],
      toRemove: [],
      flagged: true,
      flagReason,
    };
    console.log(`[shopify-tags] DRY RUN styleCode=${styleCode} FLAGGED (ambiguous): "${dbProduct.name}"`);
    return result;
  }

  const targetTags = computeTargetTags(currentTags, audience);
  const { toAdd, toRemove } = diffTags(currentTags, targetTags);

  const result: DryRunTagsResult = {
    styleCode,
    dbName: dbProduct.name,
    audience,
    matched: true,
    candidateCount,
    shopifyProductId: product.id,
    shopifyTitle: product.title,
    currentTags,
    targetTags,
    toAdd,
    toRemove,
    flagged: false,
    flagReason: null,
  };

  console.log(
    `[shopify-tags] DRY RUN styleCode=${styleCode} product=${product.id} audience=${audience} ` +
      `source=${usedGender ? `gender:${dbProduct.gender}` : "title-fallback"} ` +
      `toAdd=${JSON.stringify(toAdd)} toRemove=${JSON.stringify(toRemove)}`,
  );

  return result;
}

// --- Phase 2: execute on one product ---

export interface ExecuteTagsResult {
  styleCode: string;
  shopifyProductId: number;
  before: string[];
  after: string[];
  changed: boolean;
  matchesTarget: boolean;
}

export async function executeTags(styleCode: string, exactTitle?: string): Promise<ExecuteTagsResult> {
  const dryRun = await dryRunTags(styleCode, exactTitle);

  if (dryRun.flagged) {
    throw new Error(`Cannot execute — ${dryRun.flagReason}`);
  }
  if (!dryRun.matched || dryRun.shopifyProductId === null) {
    throw new Error(`Cannot execute — no unambiguous Shopify match for styleCode "${styleCode}"`);
  }

  if (dryRun.toAdd.length === 0 && dryRun.toRemove.length === 0) {
    console.log(`[shopify-tags] EXECUTE styleCode=${styleCode} — already at target, no write needed`);
    return {
      styleCode,
      shopifyProductId: dryRun.shopifyProductId,
      before: dryRun.currentTags,
      after: dryRun.currentTags,
      changed: false,
      matchesTarget: true,
    };
  }

  const input = {
    id: shopifyProductGid(dryRun.shopifyProductId),
    tags: dryRun.targetTags,
  };

  console.log(
    `[shopify-tags] sending productUpdate mutation for product=${dryRun.shopifyProductId}: ` +
      `${PRODUCT_UPDATE_MUTATION.trim()} variables=${JSON.stringify({ input })}`,
  );

  const res = await shopifyGraphQL<ProductUpdateResponse>(PRODUCT_UPDATE_MUTATION, { input });
  if (res.errors?.length) {
    throw new Error(`productUpdate GraphQL error: ${JSON.stringify(res.errors)}`);
  }
  const payload = res.data?.productUpdate;
  if (!payload) {
    throw new Error(`productUpdate returned no payload: ${JSON.stringify(res)}`);
  }
  if (payload.userErrors.length > 0) {
    throw new Error(`productUpdate userErrors: ${JSON.stringify(payload.userErrors)}`);
  }

  await sleep(CALL_PACING_MS);

  // Re-pull independently rather than trust the mutation's own echo.
  const products = await fetchAllShopifyProducts();
  const { product } = matchShopifyProduct(styleCode, products, exactTitle);
  const after = product ? parseTags(product.tags) : [];

  const result: ExecuteTagsResult = {
    styleCode,
    shopifyProductId: dryRun.shopifyProductId,
    before: dryRun.currentTags,
    after,
    changed: true,
    matchesTarget: tagSetsEqual(after, dryRun.targetTags),
  };

  console.log(
    `[shopify-tags] EXECUTE styleCode=${styleCode} product=${dryRun.shopifyProductId} ` +
      `matchesTarget=${result.matchesTarget} after=${JSON.stringify(after)}`,
  );

  return result;
}

// --- Phase 3: batch across all products, resumable, chunk-able ---
//
// "flagged" (ambiguous audience or no unambiguous Shopify match) is a
// terminal status, same as "ok"/"unchanged" — it's not a failure to retry,
// it's a permanent hand-off to manual review. Only "failed" (an actual
// error — network, userErrors, etc.) gets retried on the next run.

export interface BatchTagsLogEntry {
  styleCode: string;
  shopifyProductId: number | null;
  status: "ok" | "unchanged" | "flagged" | "failed";
  toAdd: string[];
  toRemove: string[];
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
        const entry = JSON.parse(line) as BatchTagsLogEntry;
        if (entry.status === "ok" || entry.status === "unchanged" || entry.status === "flagged") {
          done.add(entry.styleCode);
        }
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // no log yet
  }
  return done;
}

async function appendLog(entry: BatchTagsLogEntry): Promise<void> {
  await appendFile(BATCH_LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
}

export interface BatchTagsReport {
  total: number;
  skippedAlreadyDone: number;
  processedThisRun: number;
  remaining: number;
  updated: number;
  unchanged: number;
  flagged: number;
  failed: number;
  entries: BatchTagsLogEntry[];
}

// Processes at most `chunkSize` not-yet-logged products per call (default:
// all of them). Safe to call repeatedly — already-logged styleCodes
// (ok/unchanged/flagged) are skipped, so a chunked run just picks up where
// the last one left off. Pass `forceStyleCodes` to reprocess specific
// styleCodes regardless of prior "flagged" status — e.g. after loosening
// classifyAudience(), to retry the ones a stricter rule had flagged.
export async function batchTags(chunkSize?: number, forceStyleCodes?: string[]): Promise<BatchTagsReport> {
  const dbProducts = await prisma.product.findMany({ select: { styleCode: true } });
  const styleCodes = [...new Set(dbProducts.map((p) => p.styleCode))];
  const completed = await loadCompletedStyleCodes();
  const forced = new Set(forceStyleCodes ?? []);

  const report: BatchTagsReport = {
    total: styleCodes.length,
    skippedAlreadyDone: 0,
    processedThisRun: 0,
    remaining: 0,
    updated: 0,
    unchanged: 0,
    flagged: 0,
    failed: 0,
    entries: [],
  };

  for (const styleCode of styleCodes) {
    if (completed.has(styleCode) && !forced.has(styleCode)) {
      report.skippedAlreadyDone += 1;
      continue;
    }

    if (chunkSize !== undefined && report.processedThisRun >= chunkSize) {
      report.remaining += 1;
      continue;
    }

    try {
      const result = await executeTags(styleCode);
      const status: BatchTagsLogEntry["status"] = result.changed ? "ok" : "unchanged";
      const entry: BatchTagsLogEntry = {
        styleCode,
        shopifyProductId: result.shopifyProductId,
        status,
        toAdd: result.after.filter((t) => !result.before.includes(t)),
        toRemove: result.before.filter((t) => !result.after.includes(t)),
        message: result.matchesTarget ? undefined : "post-write tags did not match target on re-pull",
        at: new Date().toISOString(),
      };
      await appendLog(entry);
      report.entries.push(entry);
      report.processedThisRun += 1;
      if (status === "ok") report.updated += 1;
      else report.unchanged += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isFlagged = message.startsWith("Cannot execute —");
      const entry: BatchTagsLogEntry = {
        styleCode,
        shopifyProductId: null,
        status: isFlagged ? "flagged" : "failed",
        toAdd: [],
        toRemove: [],
        message,
        at: new Date().toISOString(),
      };
      await appendLog(entry);
      report.entries.push(entry);
      report.processedThisRun += 1;
      if (isFlagged) report.flagged += 1;
      else report.failed += 1;
    }

    await sleep(CALL_PACING_MS);
  }

  console.log(
    `[shopify-tags] BATCH complete total=${report.total} skipped=${report.skippedAlreadyDone} ` +
      `processedThisRun=${report.processedThisRun} remaining=${report.remaining} ` +
      `updated=${report.updated} unchanged=${report.unchanged} flagged=${report.flagged} failed=${report.failed}`,
  );

  return report;
}
