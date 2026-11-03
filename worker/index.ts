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
import { pollOrderFiles } from "@/lib/order-file-worker";

const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;
// Order-intake poll (lib/order-file-worker.ts): short, since a paid order's
// sheet should reach the vendor within about a minute. Independent of the sync.
const ORDER_POLL_INTERVAL_MS = 60 * 1000;

// A handful of failed variants in one push is typically transient
// (rate-limit backoff, one bad batch) and self-recovers next cycle — not
// worth an email. More than this, especially if it isn't a one-off, points
// at something systemic (Shopify API issue, broken auth, mass stale IDs).
const PUSH_FAILURE_ALERT_THRESHOLD = 20;

// Matches Shopify's wording for a variant/inventory item that no longer
// exists at the ID we have on file (rebuilt on Shopify since our last
// relink) — the case the stale-ID self-heal targets specifically, not every
// push failure (throttling, validation errors, etc. don't warrant a relink).
const STALE_ID_PATTERN =
  /does not exist|not found|invalid.*inventory ?item|could not find/i;

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function hasStaleIdFailure(
  entries: { status: string; message?: string }[],
): boolean {
  return entries.some(
    (e) =>
      e.status === "failed" && e.message && STALE_ID_PATTERN.test(e.message),
  );
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

  log(
    `sync: DB caught up (matched=${applyResult.matched} updated=${applyResult.updated} ` +
      `unmatched=${applyResult.unmatched.length}) — proceeding to Shopify push`,
  );

  let pushReport = await executePush({ cycleId });
  log(
    `sync: push ok=${pushReport.ok} failed=${pushReport.failed} ` +
      `trackingEnabled=${pushReport.trackingEnabled} trackingFailed=${pushReport.trackingFailed.length}`,
  );

  if (pushReport.failed > 0 && hasStaleIdFailure(pushReport.entries)) {
    log(
      "sync: stale inventory item ID detected in push failures — relinking and retrying once",
    );
    try {
      const relinkResult = await executeRelink();
      log(
        `sync: relink complete (updated=${relinkResult.updated}) — retrying push`,
      );
      pushReport = await executePush({ cycleId: `${cycleId}:retry` });
      log(`sync: retry push ok=${pushReport.ok} failed=${pushReport.failed} casConflicts=${pushReport.casConflicts}`);
    } catch (err) {
      log(
        `sync: relink/retry failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

  await recordSuccessfulSync();
  log("sync: complete");
}

async function runSyncSafely(): Promise<void> {
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
