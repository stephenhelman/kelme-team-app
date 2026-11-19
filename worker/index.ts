/**
 * Persistent Railway worker — .claude/docs/SPRINT_SYNC_WORKER.md. Runs the
 * proven pipeline (applyStockToDb wraps pullLiveStock -> DB, then
 * executePush -> Shopify, then verifyPush) on a 4h timer. No HTTP port;
 * kept out of the Vercel build via .vercelignore. Imports lib/ directly —
 * bypasses the Next route admin-auth gates on purpose, since there's no
 * request here to gate.
 */
import { applyStockToDb } from "@/lib/kelme-inventory";
import { executePush, verifyPush } from "@/lib/shopify-inventory-push";
import { executeRelink } from "@/lib/shopify-relink";
import { reportSyncAlert } from "@/lib/admin-notify";
import { recordSuccessfulSync } from "@/lib/sync-status";
import { isStaleIdMessage } from "@/lib/inventory-errors";
import {
  PUSH_FAILURE_ALERT_THRESHOLD,
  VERIFY_MISMATCH_ALERT_THRESHOLD,
  flipAlertBody,
  newVariantAlertBody,
  shouldRecordSuccessfulSync,
  shouldRelink,
  skippedStaleAlertBody,
  verifyMismatchAlertBody,
} from "@/lib/sync-policy";
import { prisma } from "@/lib/prisma";
import { pollOrderFiles } from "@/lib/order-file-worker";
import { autoConfigFromEnv, runAutoDraftsOnce } from "@/lib/auto-drafts";

const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;
// Order-intake poll (lib/order-file-worker.ts): short, since a paid order's
// sheet should reach the vendor within about a minute. Independent of the sync.
const ORDER_POLL_INTERVAL_MS = 60 * 1000;

// Failed-variant alert threshold lives in lib/sync-policy.ts (PUSH_FAILURE_ALERT_THRESHOLD).

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function hasStaleIdFailure(
  entries: { status: string; message?: string }[],
): boolean {
  return entries.some((e) => e.status === "failed" && isStaleIdMessage(e.message));
}

async function runSync(): Promise<void> {
  // One id per cycle scopes the push's idempotency keys, so a retried chunk
  // within this cycle can't apply twice; a new cycle always gets new keys.
  const cycleId = new Date().toISOString();
  log(`sync: starting (cycle ${cycleId})`);

  const applyResult = await applyStockToDb();

  if (applyResult.pullReport.stoppedEarly) {
    log(
      `sync: HALTED — dead Kelme token (${applyResult.pullReport.stopReason}). ` +
        `No Shopify write attempted. Manual re-auth required before the next sync can proceed.`,
    );
    return;
  }

  if (applyResult.halted) {
    log(
      `sync: HALTED — sanity bound tripped (${applyResult.haltReason}). No Shopify write attempted.`,
    );
    await reportSyncAlert({
      kind: "sanity_halt",
      isBad: true,
      subject: "Kelme sync halted by sanity guard",
      body:
        `The Kelme pull -> DB sync halted without writing:\n\n${applyResult.haltReason}\n\n` +
        "Existing DB and Shopify data were left untouched. This usually means a broken/partial " +
        "Kelme pull — check the worker logs and Kelme session before assuming it'll self-heal.",
    });
    return;
  }

  await reportSyncAlert({ kind: "sanity_halt", isBad: false });

  // New Kelme color/size on a live product (the DB never auto-adds variants): tell the admin exactly what to run.
  if (applyResult.unmatched.length > 0) {
    await reportSyncAlert({
      kind: "new_kelme_variants",
      isBad: true,
      subject: `Kelme sync: ${applyResult.unmatched.length} new Kelme variant(s) on live products need adding`,
      body: newVariantAlertBody(applyResult.unmatched),
    });
  } else {
    await reportSyncAlert({ kind: "new_kelme_variants", isBad: false });
  }

  log(
    `sync: DB caught up (matched=${applyResult.matched} updated=${applyResult.updated} ` +
      `unmatched=${applyResult.unmatched.length}) — proceeding to Shopify push`,
  );

  let pushReport = await executePush({ cycleId });
  log(
    `sync: push ok=${pushReport.ok} failed=${pushReport.failed} skippedStale=${pushReport.skippedStale} ` +
      `trackingEnabled=${pushReport.trackingEnabled} trackingFailed=${pushReport.trackingFailed.length}`,
  );
  // Entries for the skipped_stale alert, captured from the FIRST push (the retry re-skips the same items).
  const staleEntries = pushReport.entries.filter((e) => e.status === "skipped_stale");

  if (shouldRelink({ skippedStale: pushReport.skippedStale, failed: pushReport.failed, hasStaleIdFailure: hasStaleIdFailure(pushReport.entries) })) {
    log("sync: deleted/stale inventory items detected — relinking and retrying once");
    try {
      const relinkResult = await executeRelink();
      log(`sync: relink complete (updated=${relinkResult.updated} flippedOff=${relinkResult.flippedOff.length}) — retrying push`);
      if (relinkResult.flippedOff.length > 0 || relinkResult.removedVariants.length > 0) {
        await reportSyncAlert({
          kind: "onshopify_flip",
          isBad: true,
          subject: `Kelme sync: ${relinkResult.flippedOff.length} product(s) and ${relinkResult.removedVariants.length} variant(s) disappeared from Shopify`,
          body: flipAlertBody(relinkResult.flippedOff, relinkResult.deletedProducts, relinkResult.removedVariants),
        });
      } else {
        await reportSyncAlert({ kind: "onshopify_flip", isBad: false });
      }
      pushReport = await executePush({ cycleId: `${cycleId}:retry` });
      log(`sync: retry push ok=${pushReport.ok} failed=${pushReport.failed} skippedStale=${pushReport.skippedStale} casConflicts=${pushReport.casConflicts}`);
    } catch (err) {
      log(`sync: relink/retry failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    await reportSyncAlert({ kind: "onshopify_flip", isBad: false });
  }

  if (staleEntries.length > 0) {
    const entries = staleEntries;
    const rows = await prisma.variant.findMany({ where: { id: { in: entries.map((e) => e.variantId) } }, select: { id: true, sku: true } });
    await reportSyncAlert({
      kind: "skipped_stale",
      isBad: true,
      subject: `Kelme sync: ${entries.length} variants skipped — inventory item deleted on Shopify`,
      body: skippedStaleAlertBody(entries, new Map(rows.map((r) => [r.id, r.sku]))),
    });
  } else {
    await reportSyncAlert({ kind: "skipped_stale", isBad: false });
  }

  if (pushReport.failed > PUSH_FAILURE_ALERT_THRESHOLD) {
    await reportSyncAlert({
      kind: "push_failures",
      isBad: true,
      subject: `Kelme sync: Shopify push failing (${pushReport.failed} variants)`,
      body:
        `The Shopify inventory push failed on ${pushReport.failed} variants this cycle ` +
        `(ok=${pushReport.ok}), above the ${PUSH_FAILURE_ALERT_THRESHOLD}-variant transient threshold. ` +
        "That's beyond an isolated blip — check Shopify API status, rate limits, and recent push logs.",
    });
  } else {
    await reportSyncAlert({ kind: "push_failures", isBad: false });
  }

  // CAS conflicts mean Shopify's quantity moved between our read and write
  // (orders landing mid-push, manual edits). A few per cycle is normal and
  // self-heals next cycle; a pile of them means something is rewriting
  // inventory underneath the sync. Same threshold as push failures.
  if (pushReport.casConflicts > PUSH_FAILURE_ALERT_THRESHOLD) {
    await reportSyncAlert({
      kind: "cas_conflicts",
      isBad: true,
      subject: `Kelme sync: ${pushReport.casConflicts} inventory compare-and-swap conflicts`,
      body:
        `${pushReport.casConflicts} variants were skipped this cycle because Shopify's on_hand changed ` +
        `between the sync's read and write (threshold ${PUSH_FAILURE_ALERT_THRESHOLD}). Nothing was overwritten, ` +
        "and they retry next cycle. Persistent conflicts suggest another app or a person is editing inventory concurrently.",
    });
  } else {
    await reportSyncAlert({ kind: "cas_conflicts", isBad: false });
  }

  const verifyResult = await verifyPush();
  log(
    `sync: verify totalChecked=${verifyResult.totalChecked} correct=${verifyResult.correct} ` +
      `mismatched=${verifyResult.mismatched.length}`,
  );
  if (verifyResult.mismatched.length > 0) {
    log(
      `sync: verify mismatches: ${JSON.stringify(verifyResult.mismatched.slice(0, 10))}`,
    );
  }
  if (verifyResult.mismatched.length > VERIFY_MISMATCH_ALERT_THRESHOLD) {
    await reportSyncAlert({
      kind: "verify_mismatch",
      isBad: true,
      subject: `Kelme sync: ${verifyResult.mismatched.length} variants differ from Shopify after the push`,
      body: verifyMismatchAlertBody(verifyResult.mismatched.length, verifyResult.mismatched),
    });
  } else {
    await reportSyncAlert({ kind: "verify_mismatch", isBad: false });
  }

  // The heartbeat only advances on a cycle whose push worked — otherwise "last successful sync" lies.
  if (shouldRecordSuccessfulSync(pushReport.failed)) {
    await recordSuccessfulSync();
    log("sync: complete");
  } else {
    log(`sync: complete WITH ${pushReport.failed} FAILED push items — heartbeat NOT advanced`);
  }
}

let syncRunning = false;
async function runSyncSafely(): Promise<void> {
  syncRunning = true;
  try {
    await runSync();
    await reportSyncAlert({ kind: "sync_failure", isBad: false });
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`sync: FAILED with unexpected error: ${message}`);
    await reportSyncAlert({
      kind: "sync_failure",
      isBad: true,
      subject: "Kelme sync: cycle failed unexpectedly",
      body: `The sync worker threw an unhandled error and the cycle did not complete:\n\n${message}`,
    }).catch((notifyErr) =>
      log(`sync: failed to report sync_failure alert: ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`),
    );
  } finally {
    syncRunning = false;
  }
}

let orderPollRunning = false;
async function pollOrdersSafely(): Promise<void> {
  if (orderPollRunning) return; // a slow poll must not overlap the next tick
  orderPollRunning = true;
  try {
    await pollOrderFiles(log);
  } catch (err) {
    log(`order-file: poll failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    orderPollRunning = false;
  }
}

process.on("SIGTERM", () => {
  console.log("[worker] SIGTERM received — shutting down cleanly");
  process.exit(0);
});
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandled rejection:", reason);
});

log(`worker: starting — sync every ${SYNC_INTERVAL_MS / (60 * 60 * 1000)}h`);
runSyncSafely();
setInterval(runSyncSafely, SYNC_INTERVAL_MS);

log(`worker: order-file poll every ${ORDER_POLL_INTERVAL_MS / 1000}s`);
pollOrdersSafely();
setInterval(pollOrdersSafely, ORDER_POLL_INTERVAL_MS);

// Daily favorites -> drafts (lib/auto-drafts.ts). Off unless AUTO_DRAFTS_ENABLED=true. The hourly tick only
// *checks* whether a run is due (one attempt per ~day, recorded in the DB, so a restart or crash never loops).
const AUTO_DRAFTS_TICK_MS = 60 * 60 * 1000;
let autoDraftsRunning = false;
async function autoDraftsSafely(): Promise<void> {
  if (autoDraftsRunning || syncRunning) return; // never overlap itself or the inventory sync; the next tick checks again
  autoDraftsRunning = true;
  try {
    await runAutoDraftsOnce(log);
  } catch (err) {
    log(`auto-drafts: tick failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    autoDraftsRunning = false;
  }
}
const autoCfg = autoConfigFromEnv(process.env);
log(`worker: auto-drafts ${autoCfg.enabled ? `ENABLED (cap ${autoCfg.cap}/run, checked hourly)` : "disabled (set AUTO_DRAFTS_ENABLED=true to enable)"}`);
if (autoCfg.enabled) {
  setTimeout(autoDraftsSafely, 3 * 60 * 1000); // let the first sync get going
  setInterval(autoDraftsSafely, AUTO_DRAFTS_TICK_MS);
}
