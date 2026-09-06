/**
 * Stage 3 of .claude/docs/SPRINT_INVENTORY_PUSH.md: DB Variant.qty -> live
 * Shopify inventory levels, at a single confirmed location. SET absolute
 * on-hand quantities (inventorySetQuantities, name:"on_hand") — never
 * adjust/delta — so qty 0 correctly pushes 0 (made-to-order/out-of-stock),
 * never skipped.
 *
 * Three gated entry points:
 *   - dryRunPush   — read-only against Shopify. Confirms the location, pulls
 *                    current on_hand + tracked per variant via nodes(ids:),
 *                    diffs against DB qty, flags suspicious drops.
 *   - executePush  — enables tracking where needed, then writes only the
 *                    variants that differ, chunked, rate-limited with
 *                    backoff. Recomputes candidates fresh every call (no
 *                    cross-run "already done" skip) — re-running is a
 *                    harmless no-op for already-correct variants since
 *                    writes are absolute SETs, not deltas.
 *   - verifyPush   — re-pulls from Shopify, confirms every pushed variant
 *                    landed at its target quantity.
 */
import { appendFile } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { shopifyGraphQL } from "@/lib/shopify";

const CALL_PACING_MS = 400;
const WRITE_LOG_PATH = path.join(process.cwd(), "shopify-inventory-push-log.jsonl");
const NODES_CHUNK = 250;
const SET_QUANTITIES_CHUNK = 100;

// Confirmed live against the store on 2026-09-05 — "2244 S Santa Fe Ave",
// the location used in the earlier manual test. dryRunPush re-confirms this
// on every call (location() query) rather than trusting this constant blindly.
export const INVENTORY_LOCATION_ID = "gid://shopify/Location/73145221316";
export const EXPECTED_LOCATION_ADDRESS_FRAGMENT = "2244 S Santa Fe Ave";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function shopifyInventoryItemGid(id: string): string {
  return id.startsWith("gid://") ? id : `gid://shopify/InventoryItem/${id}`;
}

// --- Location confirmation ---

const LOCATION_QUERY = `
  query confirmLocation($id: ID!) {
    location(id: $id) {
      id
      name
      isActive
      address { address1 city provinceCode zip country }
    }
  }
`;

interface LocationQueryResponse {
  location: {
    id: string;
    name: string;
    isActive: boolean;
    address: { address1: string | null; city: string | null; provinceCode: string | null; zip: string | null; country: string | null };
  } | null;
}

export interface LocationConfirmation {
  locationId: string;
  found: boolean;
  matchesExpectedAddress: boolean;
  name: string | null;
  address1: string | null;
  isActive: boolean | null;
}

export async function confirmLocation(): Promise<LocationConfirmation> {
  const res = await shopifyGraphQL<LocationQueryResponse>(LOCATION_QUERY, { id: INVENTORY_LOCATION_ID });
  if (res.errors?.length) throw new Error(`location query error: ${JSON.stringify(res.errors)}`);
  const location = res.data?.location;
  if (!location) {
    return { locationId: INVENTORY_LOCATION_ID, found: false, matchesExpectedAddress: false, name: null, address1: null, isActive: null };
  }
  return {
    locationId: location.id,
    found: true,
    matchesExpectedAddress: (location.address.address1 ?? "").includes(EXPECTED_LOCATION_ADDRESS_FRAGMENT),
    name: location.name,
    address1: location.address.address1,
    isActive: location.isActive,
  };
}

// --- Fetching current Shopify state per inventory item ---

const NODES_QUERY = `
  query inventoryItemNodes($ids: [ID!]!, $locationId: ID!) {
    nodes(ids: $ids) {
      id
      ... on InventoryItem {
        sku
        tracked
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["on_hand"]) { name quantity }
        }
      }
    }
  }
`;

interface InventoryItemNode {
  id: string;
  sku: string;
  tracked: boolean;
  inventoryLevel: { quantities: { name: string; quantity: number }[] } | null;
}
interface NodesResponse {
  nodes: (InventoryItemNode | null)[];
}

interface CurrentInventoryState {
  inventoryItemGid: string;
  tracked: boolean;
  currentOnHand: number | null; // null = no inventory level at this location yet
}

async function fetchCurrentInventoryState(inventoryItemGids: string[]): Promise<Map<string, CurrentInventoryState>> {
  const result = new Map<string, CurrentInventoryState>();
  for (const batch of chunk(inventoryItemGids, NODES_CHUNK)) {
    const res = await shopifyGraphQL<NodesResponse>(NODES_QUERY, { ids: batch, locationId: INVENTORY_LOCATION_ID });
    if (res.errors?.length) throw new Error(`nodes(ids:) GraphQL error: ${JSON.stringify(res.errors)}`);
    for (const node of res.data?.nodes ?? []) {
      if (!node) continue;
      const onHand = node.inventoryLevel?.quantities.find((q) => q.name === "on_hand")?.quantity ?? null;
      result.set(node.id, { inventoryItemGid: node.id, tracked: node.tracked, currentOnHand: onHand });
    }
    await sleep(CALL_PACING_MS);
  }
  return result;
}

// --- Phase 1: dry-run diff ---

// A variant with substantial current stock dropping to a target of 0 is
// exactly the "lots-of-stock to 0" case the sprint calls out — flagged for
// human review in the dry-run, not auto-blocked (a real made-to-order
// transition is legitimate; a broken pull silently zeroing everything is
// not, and that whole-catalog case is caught separately by applyStockToDb's
// sanity bound before this stage ever sees it).
const SUSPICIOUS_DROP_THRESHOLD = 10;

export interface PushCandidate {
  variantId: number;
  sku: string;
  inventoryItemGid: string;
  currentOnHand: number | null;
  targetQty: number;
  trackingDisabled: boolean;
  suspiciousDrop: boolean;
}

export interface DryRunPushResult {
  location: LocationConfirmation;
  totalOnShopifyVariants: number;
  nullInventoryItemId: { variantId: number; sku: string }[];
  alreadyCorrect: number;
  toPush: PushCandidate[];
  suspiciousDrops: PushCandidate[];
  trackingDisabledCount: number;
}

export async function dryRunPush(): Promise<DryRunPushResult> {
  const location = await confirmLocation();

  const variants = await prisma.variant.findMany({
    where: { product: { onShopify: true } },
    select: { id: true, sku: true, qty: true, shopifyInventoryItemId: true },
  });

  const nullInventoryItemId = variants
    .filter((v) => !v.shopifyInventoryItemId)
    .map((v) => ({ variantId: v.id, sku: v.sku }));

  const withGid = variants.filter((v): v is typeof v & { shopifyInventoryItemId: string } => Boolean(v.shopifyInventoryItemId));
  const gidByVariantId = new Map(withGid.map((v) => [v.id, shopifyInventoryItemGid(v.shopifyInventoryItemId)]));
  const currentState = await fetchCurrentInventoryState([...gidByVariantId.values()]);

  let alreadyCorrect = 0;
  const toPush: PushCandidate[] = [];
  const suspiciousDrops: PushCandidate[] = [];
  let trackingDisabledCount = 0;

  for (const v of withGid) {
    const gid = gidByVariantId.get(v.id)!;
    const state = currentState.get(gid);
    const currentOnHand = state?.currentOnHand ?? null;
    const trackingDisabled = state ? !state.tracked : false;
    if (trackingDisabled) trackingDisabledCount += 1;

    if (currentOnHand === v.qty && !trackingDisabled) {
      alreadyCorrect += 1;
      continue;
    }

    const suspiciousDrop = v.qty === 0 && (currentOnHand ?? 0) >= SUSPICIOUS_DROP_THRESHOLD;
    const candidate: PushCandidate = {
      variantId: v.id,
      sku: v.sku,
      inventoryItemGid: gid,
      currentOnHand,
      targetQty: v.qty,
      trackingDisabled,
      suspiciousDrop,
    };
    toPush.push(candidate);
    if (suspiciousDrop) suspiciousDrops.push(candidate);
  }

  const result: DryRunPushResult = {
    location,
    totalOnShopifyVariants: variants.length,
    nullInventoryItemId,
    alreadyCorrect,
    toPush,
    suspiciousDrops,
    trackingDisabledCount,
  };

  console.log(
    `[shopify-inventory-push] DRY RUN location=${location.name ?? "NOT FOUND"} matchesExpected=${location.matchesExpectedAddress} ` +
      `total=${result.totalOnShopifyVariants} toPush=${toPush.length} alreadyCorrect=${alreadyCorrect} ` +
      `suspiciousDrops=${suspiciousDrops.length} trackingDisabled=${trackingDisabledCount} nullInventoryItemId=${nullInventoryItemId.length}`,
  );

  return result;
}

// --- Phase 2: execute ---

const ENABLE_TRACKING_MUTATION = `
  mutation enableTracking($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem { id tracked }
      userErrors { field message }
    }
  }
`;
interface EnableTrackingResponse {
  inventoryItemUpdate: { inventoryItem: { id: string; tracked: boolean } | null; userErrors: { field: string[] | null; message: string }[] };
}

async function enableTracking(inventoryItemGid: string): Promise<void> {
  const res = await shopifyGraphQL<EnableTrackingResponse>(ENABLE_TRACKING_MUTATION, {
    id: inventoryItemGid,
    input: { tracked: true },
  });
  if (res.errors?.length) throw new Error(`inventoryItemUpdate GraphQL error: ${JSON.stringify(res.errors)}`);
  const payload = res.data?.inventoryItemUpdate;
  if (!payload) throw new Error(`inventoryItemUpdate returned no payload: ${JSON.stringify(res)}`);
  if (payload.userErrors.length > 0) throw new Error(`inventoryItemUpdate userErrors: ${JSON.stringify(payload.userErrors)}`);
}

// No @idempotent directive — this store is pinned to API version 2025-04
// (lib/shopify.ts's SHOPIFY_API_VERSION, from .env), which predates the
// directive entirely ("Directive @idempotent is not defined", confirmed
// live). The directive only becomes optional at 2026-01 and required at
// 2026-04 — neither applies here.
const SET_QUANTITIES_MUTATION = `
  mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        changes { name delta quantityAfterChange }
      }
      userErrors { field message code }
    }
  }
`;
interface SetQuantitiesResponse {
  inventorySetQuantities: {
    inventoryAdjustmentGroup: { changes: { name: string; delta: number; quantityAfterChange: number | null }[] } | null;
    userErrors: { field: string[] | null; message: string; code: string }[];
  };
}

function isThrottled(message: string): boolean {
  return /throttled/i.test(message);
}

async function setQuantitiesWithBackoff(
  quantities: { inventoryItemId: string; locationId: string; quantity: number }[],
): Promise<void> {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await shopifyGraphQL<SetQuantitiesResponse>(SET_QUANTITIES_MUTATION, {
      input: { name: "on_hand", reason: "correction", quantities, ignoreCompareQuantity: true },
    });

    if (res.errors?.length) {
      const message = JSON.stringify(res.errors);
      if (isThrottled(message) && attempt < maxAttempts - 1) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`inventorySetQuantities GraphQL error: ${message}`);
    }
    const payload = res.data?.inventorySetQuantities;
    if (!payload) throw new Error(`inventorySetQuantities returned no payload: ${JSON.stringify(res)}`);
    if (payload.userErrors.length > 0) {
      const message = JSON.stringify(payload.userErrors);
      if (isThrottled(message) && attempt < maxAttempts - 1) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error(`inventorySetQuantities userErrors: ${message}`);
    }
    return;
  }
  throw new Error(`inventorySetQuantities exhausted retries (still throttled)`);
}

export interface InventoryPushLogEntry {
  variantId: number;
  inventoryItemGid: string;
  targetQty: number;
  status: "ok" | "failed";
  message?: string;
  at: string;
}

async function appendLog(entries: InventoryPushLogEntry[]): Promise<void> {
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await appendFile(WRITE_LOG_PATH, lines, "utf8");
}

export interface ExecutePushReport {
  candidates: number;
  trackingEnabled: number;
  trackingFailed: { variantId: number; inventoryItemGid: string; error: string }[];
  processedThisRun: number;
  remaining: number;
  ok: number;
  failed: number;
  entries: InventoryPushLogEntry[];
}

// Processes at most `chunkSize` of this run's candidates per call (default:
// all of them). Enables tracking first for any variant that needs it (a
// disabled inventory item silently drops its level write otherwise), then
// sets absolute on_hand quantities in batches of up to 100.
//
// No cross-run "already done" skip: dryRunPush recomputes candidates fresh
// against live Shopify state + current DB qty every call, so re-pushing a
// variant that was already pushed correctly is a harmless no-op (SET, not
// delta). A previous version skipped variants whose id ever appeared as
// "ok" in the append-only log, from ANY prior run — which meant a variant
// pushed once, then re-synced to a new DB qty later (via the automatic
// inventory worker), would be silently frozen at its stale Shopify value
// forever, since its id was already marked "done". Full runs take ~25s, so
// resumability wasn't worth that bug class.
export async function executePush(chunkSize?: number): Promise<ExecutePushReport> {
  const dryRun = await dryRunPush();
  if (!dryRun.location.found || !dryRun.location.matchesExpectedAddress) {
    throw new Error(
      `Cannot execute — location confirmation failed (found=${dryRun.location.found}, ` +
        `matchesExpectedAddress=${dryRun.location.matchesExpectedAddress}, name=${dryRun.location.name})`,
    );
  }

  const pending = dryRun.toPush;
  const candidates = pending.length;

  const report: ExecutePushReport = {
    candidates,
    trackingEnabled: 0,
    trackingFailed: [],
    processedThisRun: 0,
    remaining: 0,
    ok: 0,
    failed: 0,
    entries: [],
  };

  const toProcess = chunkSize !== undefined ? pending.slice(0, chunkSize) : pending;
  report.remaining = pending.length - toProcess.length;

  const needsTracking = toProcess.filter((v) => v.trackingDisabled);
  const trackingFailedIds = new Set<number>();
  for (const v of needsTracking) {
    try {
      await enableTracking(v.inventoryItemGid);
      report.trackingEnabled += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report.trackingFailed.push({ variantId: v.variantId, inventoryItemGid: v.inventoryItemGid, error: message });
      trackingFailedIds.add(v.variantId);
    }
    await sleep(CALL_PACING_MS);
  }

  const writable = toProcess.filter((v) => !trackingFailedIds.has(v.variantId));
  for (const batch of chunk(writable, SET_QUANTITIES_CHUNK)) {
    const at = new Date().toISOString();
    try {
      await setQuantitiesWithBackoff(
        batch.map((v) => ({ inventoryItemId: v.inventoryItemGid, locationId: INVENTORY_LOCATION_ID, quantity: v.targetQty })),
      );
      const entries: InventoryPushLogEntry[] = batch.map((v) => ({
        variantId: v.variantId,
        inventoryItemGid: v.inventoryItemGid,
        targetQty: v.targetQty,
        status: "ok",
        at,
      }));
      await appendLog(entries);
      report.entries.push(...entries);
      report.processedThisRun += batch.length;
      report.ok += batch.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const entries: InventoryPushLogEntry[] = batch.map((v) => ({
        variantId: v.variantId,
        inventoryItemGid: v.inventoryItemGid,
        targetQty: v.targetQty,
        status: "failed",
        message,
        at,
      }));
      await appendLog(entries);
      report.entries.push(...entries);
      report.processedThisRun += batch.length;
      report.failed += batch.length;
    }
    await sleep(CALL_PACING_MS);
  }

  // trackingFailedIds never got a set-quantities attempt at all — log them
  // as failed too, so a re-run picks them back up instead of silently
  // dropping them from both the "done" and "pending" sets.
  if (trackingFailedIds.size > 0) {
    const at = new Date().toISOString();
    const entries: InventoryPushLogEntry[] = toProcess
      .filter((v) => trackingFailedIds.has(v.variantId))
      .map((v) => ({
        variantId: v.variantId,
        inventoryItemGid: v.inventoryItemGid,
        targetQty: v.targetQty,
        status: "failed",
        message: "tracking enable failed — quantity not written",
        at,
      }));
    await appendLog(entries);
    report.entries.push(...entries);
    report.processedThisRun += entries.length;
    report.failed += entries.length;
  }

  console.log(
    `[shopify-inventory-push] EXECUTE candidates=${report.candidates} ` +
      `processedThisRun=${report.processedThisRun} remaining=${report.remaining} ok=${report.ok} failed=${report.failed} ` +
      `trackingEnabled=${report.trackingEnabled} trackingFailed=${report.trackingFailed.length}`,
  );

  return report;
}

// --- Phase 3: verify by re-pull ---

export interface VerifyPushResult {
  totalChecked: number;
  correct: number;
  mismatched: { variantId: number; sku: string; expectedQty: number; actualOnHand: number | null }[];
}

export async function verifyPush(): Promise<VerifyPushResult> {
  const variants = await prisma.variant.findMany({
    where: { product: { onShopify: true }, shopifyInventoryItemId: { not: null } },
    select: { id: true, sku: true, qty: true, shopifyInventoryItemId: true },
  });

  const gidByVariantId = new Map(variants.map((v) => [v.id, shopifyInventoryItemGid(v.shopifyInventoryItemId!)]));
  const currentState = await fetchCurrentInventoryState([...gidByVariantId.values()]);

  let correct = 0;
  const mismatched: VerifyPushResult["mismatched"] = [];

  for (const v of variants) {
    const gid = gidByVariantId.get(v.id)!;
    const state = currentState.get(gid);
    const actualOnHand = state?.currentOnHand ?? null;
    if (actualOnHand === v.qty) {
      correct += 1;
    } else {
      mismatched.push({ variantId: v.id, sku: v.sku, expectedQty: v.qty, actualOnHand });
    }
  }

  const result: VerifyPushResult = { totalChecked: variants.length, correct, mismatched };
  console.log(`[shopify-inventory-push] VERIFY totalChecked=${result.totalChecked} correct=${correct} mismatched=${mismatched.length}`);
  return result;
}
