import { NextRequest, NextResponse } from "next/server";
import { getLastSuccessfulSyncAt } from "@/lib/sync-status";
import { reportSyncAlert } from "@/lib/admin-notify";

// Catches the one failure mode error-notifications can't: the worker being
// down/hung entirely, which produces no error to report — only silence.
// Vercel Cron (see vercel.json) hits this on a schedule tighter than the
// staleness threshold so a dead worker is caught promptly, not just
// eventually.
const STALE_THRESHOLD_MS = 8 * 60 * 60 * 1000; // 8h
const RENOTIFY_WINDOW_MS = 6 * 60 * 60 * 1000; // keep reminding every 6h while still down

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const lastSuccessfulSyncAt = await getLastSuccessfulSyncAt();
  const ageMs = lastSuccessfulSyncAt ? Date.now() - lastSuccessfulSyncAt.getTime() : Infinity;
  const isStale = ageMs > STALE_THRESHOLD_MS;

  await reportSyncAlert({
    kind: "stale_heartbeat",
    isBad: isStale,
    persistWindowMs: RENOTIFY_WINDOW_MS,
    subject: "Kelme sync worker appears down",
    body: lastSuccessfulSyncAt
      ? `No successful sync has completed in over ${STALE_THRESHOLD_MS / (60 * 60 * 1000)}h ` +
        `(last success: ${lastSuccessfulSyncAt.toISOString()}). The worker may be down, hung, or halting ` +
        "every cycle without a distinct alert firing. Check Railway."
      : "No successful sync has ever completed (no lastSuccessfulSyncAt recorded). Check Railway and worker logs.",
  });

  return NextResponse.json({ ok: true, lastSuccessfulSyncAt, isStale });
}
