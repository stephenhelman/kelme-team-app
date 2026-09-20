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

const SYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;

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
  log("sync: starting");

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

  let pushReport = await executePush();
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
      pushReport = await executePush();
      log(`sync: retry push ok=${pushReport.ok} failed=${pushReport.failed}`);
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
