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
 *
 * Writes are compare-and-swap: each quantity carries changeFromQuantity =
 * the on_hand we read from Shopify moments earlier, so a write never
 * clobbers a quantity that changed in between (a sale, a manual edit). A
 * stale item is skipped, not overwritten — see executePush. Each batch also
 * carries an @idempotent key so a retried batch can't apply twice.
 */
import { appendFile } from "fs/promises";
import { createHash } from "crypto";
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

export interface CurrentInventoryState {
  inventoryItemGid: string;
  tracked: boolean;
  currentOnHand: number | null; // null = no inventory level at this location yet
}

export async function fetchCurrentInventoryState(inventoryItemGids: string[]): Promise<Map<string, CurrentInventoryState>> {
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

// styleCode narrows the whole run to a single product (used for supervised
// single-product test cycles); omit for the full catalog.
export async function dryRunPush(styleCode?: string): Promise<DryRunPushResult> {
  const location = await confirmLocation();

  const variants = await prisma.variant.findMany({
    where: { product: { onShopify: true, ...(styleCode ? { styleCode } : {}) } },
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

export async function enableTracking(inventoryItemGid: string): Promise<void> {
  const res = await shopifyGraphQL<EnableTrackingResponse>(ENABLE_TRACKING_MUTATION, {
    id: inventoryItemGid,
    input: { tracked: true },
  });
  if (res.errors?.length) throw new Error(`inventoryItemUpdate GraphQL error: ${JSON.stringify(res.errors)}`);
  const payload = res.data?.inventoryItemUpdate;
  if (!payload) throw new Error(`inventoryItemUpdate returned no payload: ${JSON.stringify(res)}`);
  if (payload.userErrors.length > 0) throw new Error(`inventoryItemUpdate userErrors: ${JSON.stringify(payload.userErrors)}`);
}

// API 2026-04+ requires BOTH an @idempotent(key:) directive on this mutation
// and a changeFromQuantity on every quantity (explicit null = opt out of the
// compare-and-swap check; omitting it is an error). 2026-01 accepts the key
// optionally. ignoreCompareQuantity / compareQuantity no longer exist on the
// input. Confirmed by introspection against 2026-01, 2026-04 and 2026-10.
const SET_QUANTITIES_MUTATION = `
  mutation inventorySetQuantities($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
    inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
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
    userErrors: { field: string[] | null; message: string; code: string | null }[];
  };
}

function isThrottled(message: string): boolean {
  return /throttled/i.test(message);
}

interface QuantityWrite {
  inventoryItemId: string;
  locationId: string;
  quantity: number;
  // The on_hand we last read from Shopify for this item. null only when there
  // was nothing to read (no level at this location yet) — an explicit,
  // deliberate opt-out of the check, never a default.
  changeFromQuantity: number | null;
}

// Deterministic UUID-shaped key from (cycle, chunk, exact payload). Retrying
// the identical chunk — a throttle backoff, a crashed-and-rerun cycle with the
// same id — reuses the key, so Shopify returns the original result instead of
// applying twice. The payload is part of the hash on purpose: re-submitting a
// chunk after dropping CAS-stale items is a different request, and reusing
// the old key for it would be IDEMPOTENCY_KEY_PARAMETER_MISMATCH.
function idempotencyKeyFor(scope: string, quantities: QuantityWrite[]): string {
  const h = createHash("sha256").update(JSON.stringify([scope, quantities])).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Indexes into `quantities` that Shopify reported as CAS-stale, parsed from
// the userError field path (["input","quantities","<i>","changeFromQuantity"]).
function staleIndexesOf(errors: { field: string[] | null; code: string | null }[], count: number): number[] | null {
  const indexes = new Set<number>();
  for (const e of errors) {
    if (e.code !== "CHANGE_FROM_QUANTITY_STALE") return null; // mixed errors — not a pure CAS conflict
    const idx = Number(e.field?.find((part, i) => i > 0 && e.field![i - 1] === "quantities"));
    if (!Number.isInteger(idx) || idx < 0 || idx >= count) return null; // can't attribute — treat batch as failed
    indexes.add(idx);
  }
  return [...indexes];
}

// Returns the indexes that were skipped as CAS-stale (nothing written for
// them). When ANY item is stale the whole mutation is rejected with
// userErrors — it is all-or-nothing — so the caller re-submits the rest.
export async function setQuantitiesWithBackoff(quantities: QuantityWrite[], keyScope: string): Promise<{ staleIndexes: number[] }> {
  const maxAttempts = 5;
  const idempotencyKey = idempotencyKeyFor(keyScope, quantities);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const res = await shopifyGraphQL<SetQuantitiesResponse>(SET_QUANTITIES_MUTATION, {
      input: { name: "on_hand", reason: "correction", quantities },
      idempotencyKey,
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
      const retryable = isThrottled(message) || payload.userErrors.every((e) => e.code === "IDEMPOTENCY_CONCURRENT_REQUEST");
      if (retryable && attempt < maxAttempts - 1) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const staleIndexes = staleIndexesOf(payload.userErrors, quantities.length);
      if (staleIndexes) return { staleIndexes };
      throw new Error(`inventorySetQuantities userErrors: ${message}`);
    }
    return { staleIndexes: [] };
  }
  throw new Error(`inventorySetQuantities exhausted retries (still throttled)`);
}

export interface InventoryPushLogEntry {
  variantId: number;
  inventoryItemGid: string;
  targetQty: number;
  // "conflict" = compare-and-swap mismatch: Shopify's on_hand changed between
  // our read and our write, so we deliberately did NOT overwrite it. Not a
  // failure — the next cycle re-reads and retries.
  status: "ok" | "failed" | "conflict";
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
  // Items skipped because Shopify's on_hand moved after we read it (CAS
  // mismatch). Counted apart from `failed` — a conflict is Shopify being
  // right, not the push being broken.
  casConflicts: number;
  entries: InventoryPushLogEntry[];
}

export interface ExecutePushOptions {
  chunkSize?: number;
  // Scopes idempotency keys — pass one stable id per sync cycle (and a
  // distinct one for an in-cycle retry pass). Defaults to a fresh timestamp.
  cycleId?: string;
  styleCode?: string;
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
export async function executePush(options: ExecutePushOptions = {}): Promise<ExecutePushReport> {
  const { chunkSize, styleCode } = options;
  const cycleId = options.cycleId ?? `manual-${new Date().toISOString()}`;
  const dryRun = await dryRunPush(styleCode);
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
    casConflicts: 0,
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
  const chunks = chunk(writable, SET_QUANTITIES_CHUNK);
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const batch = chunks[chunkIndex];
    const at = new Date().toISOString();
    const conflicts: PushCandidate[] = [];
    let remaining = batch;
    try {
      // One stale item rejects the whole mutation, so peel off the
      // conflicts and re-submit the rest. Bounded: a run of fresh conflicts
      // every round means something is actively churning inventory.
      for (let round = 0; remaining.length > 0 && round < 5; round += 1) {
        const { staleIndexes } = await setQuantitiesWithBackoff(
          remaining.map((v) => ({
            inventoryItemId: v.inventoryItemGid,
            locationId: INVENTORY_LOCATION_ID,
            quantity: v.targetQty,
            changeFromQuantity: v.currentOnHand,
          })),
          `${cycleId}:chunk-${chunkIndex}`,
        );
        if (staleIndexes.length === 0) {
          remaining = [];
          break;
        }
        const stale = new Set(staleIndexes);
        conflicts.push(...remaining.filter((_, i) => stale.has(i)));
        remaining = remaining.filter((_, i) => !stale.has(i));
        await sleep(CALL_PACING_MS);
      }
      if (remaining.length > 0) throw new Error("CAS conflicts persisted across 5 re-submit rounds — batch abandoned");

      const written = batch.filter((v) => !conflicts.includes(v));
      const entries: InventoryPushLogEntry[] = written.map((v) => ({
        variantId: v.variantId,
        inventoryItemGid: v.inventoryItemGid,
        targetQty: v.targetQty,
        status: "ok",
        at,
      }));
      await appendLog(entries);
      report.entries.push(...entries);
      report.processedThisRun += written.length;
      report.ok += written.length;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failedItems = batch.filter((v) => !conflicts.includes(v));
      const entries: InventoryPushLogEntry[] = failedItems.map((v) => ({
        variantId: v.variantId,
        inventoryItemGid: v.inventoryItemGid,
        targetQty: v.targetQty,
        status: "failed",
        message,
        at,
      }));
      await appendLog(entries);
      report.entries.push(...entries);
      report.processedThisRun += failedItems.length;
      report.failed += failedItems.length;
    }

    if (conflicts.length > 0) {
      // Re-read what Shopify holds now so the log says what actually
      // happened. Nothing is overwritten and nothing retried here — the next
      // cycle recomputes candidates from a fresh read.
      let fresh = new Map<string, CurrentInventoryState>();
      try {
        fresh = await fetchCurrentInventoryState(conflicts.map((v) => v.inventoryItemGid));
      } catch (err) {
        console.error(`[shopify-inventory-push] CAS re-read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const entries: InventoryPushLogEntry[] = conflicts.map((v) => {
        const now = fresh.get(v.inventoryItemGid)?.currentOnHand;
        return {
          variantId: v.variantId,
          inventoryItemGid: v.inventoryItemGid,
          targetQty: v.targetQty,
          status: "conflict",
          message: `CAS mismatch: expected on_hand ${v.currentOnHand}, Shopify now has ${now ?? "unknown"} — not overwritten, next cycle retries`,
          at,
        };
      });
      for (const e of entries.slice(0, 20)) {
        console.warn(`[shopify-inventory-push] CAS conflict sku-variant=${e.variantId} ${e.inventoryItemGid}: ${e.message}`);
      }
      await appendLog(entries);
      report.entries.push(...entries);
      report.processedThisRun += entries.length;
      report.casConflicts += entries.length;
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
      `processedThisRun=${report.processedThisRun} remaining=${report.remaining} ok=${report.ok} failed=${report.failed} casConflicts=${report.casConflicts} ` +
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
