/**
 * Orchestrates the full per-product update sequence from
 * .claude/docs/SPRINT_BATCH_UPDATE.md: productSet reconcile (options +
 * variant grid) -> size reorder -> media re-link -> tags. Gated dry-run/
 * execute/batch, same shape as every other module built this sprint —
 * this module is pure orchestration, no new mechanisms of its own.
 *
 * Skip policy (never guess, never partially edit): a product is skipped
 * entirely — no writes of any kind — if it doesn't match exactly one
 * Shopify product, or if its audience is ambiguous (equipment/accessory or
 * a title Gender/sub-category can't resolve). Skipped products are
 * reported, never silently dropped.
 */
import { appendFile, readFile } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { dryRunReconcile, executeReconcile, type DryRunResult } from "@/lib/shopify-reconcile";
import { planSizeOrder, executeSizeOrder } from "@/lib/shopify-order";
import { planMedia, executeMedia } from "@/lib/shopify-media";
import { dryRunTags, executeTags } from "@/lib/shopify-tags";

const CALL_PACING_MS = 400;
const BATCH_LOG_PATH = path.join(process.cwd(), "shopify-batch-log.jsonl");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Phase 1: combined dry-run across all four steps ---

export interface BatchDryRunResult {
  styleCode: string;
  matched: boolean;
  shopifyProductId: number | null;
  shopifyTitle: string | null;
  skipReason: string | null;
  variantsToAdd: DryRunResult["toAdd"];
  variantsToDelete: DryRunResult["toDelete"];
  currentVariantCount: number;
  deleteLooksLarge: boolean; // >50% of current variants, or deleting an allow-list size — surfaced for review, not auto-blocked
  sizeOrder: { current: string[]; target: string[]; changed: boolean } | null;
  media: { toAttach: number; alreadyAttached: number; noMediaForColor: number } | null;
  tags: { current: string[]; target: string[]; toAdd: string[]; toRemove: string[] } | null;
}

export async function dryRunBatch(styleCode: string): Promise<BatchDryRunResult> {
  const [reconcile, tags] = await Promise.all([dryRunReconcile(styleCode), dryRunTags(styleCode)]);

  const currentVariantCount = reconcile.current.length;

  if (!reconcile.matched || reconcile.shopifyProductId === null) {
    return {
      styleCode,
      matched: false,
      shopifyProductId: null,
      shopifyTitle: null,
      skipReason: `no unambiguous Shopify match (candidates=${reconcile.candidateCount})`,
      variantsToAdd: [],
      variantsToDelete: [],
      currentVariantCount,
      deleteLooksLarge: false,
      sizeOrder: null,
      media: null,
      tags: null,
    };
  }

  if (tags.flagged) {
    return {
      styleCode,
      matched: true,
      shopifyProductId: reconcile.shopifyProductId,
      shopifyTitle: reconcile.shopifyTitle,
      skipReason: `audience ambiguous — ${tags.flagReason}`,
      variantsToAdd: reconcile.toAdd,
      variantsToDelete: reconcile.toDelete,
      currentVariantCount,
      deleteLooksLarge: false,
      sizeOrder: null,
      media: null,
      tags: null,
    };
  }

  if (reconcile.missingGids.length > 0) {
    return {
      styleCode,
      matched: true,
      shopifyProductId: reconcile.shopifyProductId,
      shopifyTitle: reconcile.shopifyTitle,
      skipReason: `missing shopifyGid: ${reconcile.missingGids.join("; ")}`,
      variantsToAdd: reconcile.toAdd,
      variantsToDelete: reconcile.toDelete,
      currentVariantCount,
      deleteLooksLarge: false,
      sizeOrder: null,
      media: null,
      tags: null,
    };
  }

  const [sizeOrder, media] = await Promise.all([
    planSizeOrder(reconcile.shopifyProductId),
    planMedia(reconcile.shopifyProductId),
  ]);

  const deleteLooksLarge =
    currentVariantCount > 0 && reconcile.toDelete.length > currentVariantCount * 0.5;

  return {
    styleCode,
    matched: true,
    shopifyProductId: reconcile.shopifyProductId,
    shopifyTitle: reconcile.shopifyTitle,
    skipReason: null,
    variantsToAdd: reconcile.toAdd,
    variantsToDelete: reconcile.toDelete,
    currentVariantCount,
    deleteLooksLarge,
    sizeOrder: { current: sizeOrder.currentSizeOrder, target: sizeOrder.targetSizeOrder, changed: sizeOrder.changed },
    media: { toAttach: media.toAttachCount, alreadyAttached: media.alreadyAttachedCount, noMediaForColor: media.noMediaForColorCount },
    tags: { current: tags.currentTags, target: tags.targetTags, toAdd: tags.toAdd, toRemove: tags.toRemove },
  };
}

// --- Phase 2: execute all four steps in sequence ---

interface StepResult {
  ok: boolean;
  error?: string;
}

export interface BatchExecuteResult {
  styleCode: string;
  shopifyProductId: number;
  steps: {
    reconcile: StepResult;
    sizeOrder: StepResult;
    media: StepResult;
    tags: StepResult;
  };
  overallOk: boolean;
}

export async function executeBatch(styleCode: string): Promise<BatchExecuteResult> {
  const dryRun = await dryRunBatch(styleCode);
  if (dryRun.skipReason || dryRun.shopifyProductId === null) {
    throw new Error(`Cannot execute — ${dryRun.skipReason ?? "unknown skip reason"}`);
  }
  const shopifyProductId = dryRun.shopifyProductId;

  const steps: BatchExecuteResult["steps"] = {
    reconcile: { ok: false },
    sizeOrder: { ok: false },
    media: { ok: false },
    tags: { ok: false },
  };

  try {
    const r = await executeReconcile(styleCode);
    steps.reconcile = r.afterMatchesTarget
      ? { ok: true }
      : { ok: false, error: `stillMissing=${r.stillMissing.length} stillExtra=${r.stillExtra.length}` };
  } catch (err) {
    steps.reconcile = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  await sleep(CALL_PACING_MS);

  // Reorder/media/tags all depend on the post-reconcile variant/option
  // state (new variant IDs after any grid change) — only proceed if
  // reconcile actually landed, so a failure there can't leave a
  // half-updated product silently.
  if (steps.reconcile.ok) {
    try {
      await executeSizeOrder(shopifyProductId);
      steps.sizeOrder = { ok: true };
    } catch (err) {
      steps.sizeOrder = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await sleep(CALL_PACING_MS);

    try {
      await executeMedia(shopifyProductId);
      steps.media = { ok: true };
    } catch (err) {
      steps.media = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await sleep(CALL_PACING_MS);

    try {
      const t = await executeTags(styleCode);
      steps.tags = t.matchesTarget
        ? { ok: true }
        : { ok: false, error: "post-write tags did not match target on re-pull" };
    } catch (err) {
      steps.tags = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    await sleep(CALL_PACING_MS);
  } else {
    steps.sizeOrder = { ok: false, error: "skipped — reconcile step failed" };
    steps.media = { ok: false, error: "skipped — reconcile step failed" };
    steps.tags = { ok: false, error: "skipped — reconcile step failed" };
  }

  const overallOk = steps.reconcile.ok && steps.sizeOrder.ok && steps.media.ok && steps.tags.ok;

  return { styleCode, shopifyProductId, steps, overallOk };
}

// --- Phase 4: batch across all products, resumable, chunk-able ---

export interface BatchRunLogEntry {
  styleCode: string;
  shopifyProductId: number | null;
  status: "ok" | "partial" | "skipped" | "failed";
  steps?: BatchExecuteResult["steps"];
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
        const entry = JSON.parse(line) as BatchRunLogEntry;
        // "partial" is retryable — a genuine failure partway through, not a
        // terminal state — everything else (ok/skipped/failed) is terminal
        // so a re-run doesn't hammer the same dead end repeatedly.
        if (entry.status !== "partial") done.add(entry.styleCode);
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // no log yet
  }
  return done;
}

async function appendLog(entry: BatchRunLogEntry): Promise<void> {
  await appendFile(BATCH_LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
}

export interface BatchRunReport {
  total: number;
  skippedAlreadyDone: number;
  processedThisRun: number;
  remaining: number;
  ok: number;
  partial: number;
  skipped: number;
  failed: number;
  entries: BatchRunLogEntry[];
}

export async function runBatch(chunkSize?: number, forceStyleCodes?: string[]): Promise<BatchRunReport> {
  const dbProducts = await prisma.product.findMany({ select: { styleCode: true } });
  const styleCodes = [...new Set(dbProducts.map((p) => p.styleCode))];
  const completed = await loadCompletedStyleCodes();
  const forced = new Set(forceStyleCodes ?? []);

  const report: BatchRunReport = {
    total: styleCodes.length,
    skippedAlreadyDone: 0,
    processedThisRun: 0,
    remaining: 0,
    ok: 0,
    partial: 0,
    skipped: 0,
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
      const result = await executeBatch(styleCode);
      const status: BatchRunLogEntry["status"] = result.overallOk ? "ok" : "partial";
      const entry: BatchRunLogEntry = {
        styleCode,
        shopifyProductId: result.shopifyProductId,
        status,
        steps: result.steps,
        at: new Date().toISOString(),
      };
      await appendLog(entry);
      report.entries.push(entry);
      report.processedThisRun += 1;
      if (status === "ok") report.ok += 1;
      else report.partial += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isSkip = message.startsWith("Cannot execute —");
      const entry: BatchRunLogEntry = {
        styleCode,
        shopifyProductId: null,
        status: isSkip ? "skipped" : "failed",
        message,
        at: new Date().toISOString(),
      };
      await appendLog(entry);
      report.entries.push(entry);
      report.processedThisRun += 1;
      if (isSkip) report.skipped += 1;
      else report.failed += 1;
    }

    await sleep(CALL_PACING_MS);
  }

  console.log(
    `[shopify-batch] RUN complete total=${report.total} skipped=${report.skippedAlreadyDone} ` +
      `processedThisRun=${report.processedThisRun} remaining=${report.remaining} ` +
      `ok=${report.ok} partial=${report.partial} skippedNew=${report.skipped} failed=${report.failed}`,
  );

  return report;
}
