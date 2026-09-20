/**
 * Admin alerting for the Kelme<->Shopify sync worker — a parallel channel to
 * lib/vendor-notify.ts's Kelme re-auth email, same Resend account, different
 * recipient (ADMIN_NOTIFY_EMAIL) and different triggers: anything that means
 * inventory sync silently isn't working and a human needs to look, as
 * opposed to "the vendor needs to click a re-auth link."
 *
 * Deduping follows the same shape as lib/kelme-token.ts's deadNotifiedAt:
 * notify on the transition into a bad state, then again only if the bad
 * state persists past `persistWindowMs` since the last send — never once
 * per sync cycle, or a transient blip (a retry that succeeds, one push
 * batch failing) would become alert-fatigue noise.
 */
import { prisma } from "./prisma";

const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_PERSIST_WINDOW_MS = 12 * 60 * 60 * 1000; // 12h

/**
 * Sends immediately, bypassing dedup/persist-window state entirely — for
 * scripts/test-alert.mjs, so a manual check always produces an email
 * instead of possibly being swallowed by reportSyncAlert's dedup.
 */
export async function sendTestAlert(): Promise<void> {
  await sendAdminAlert(
    "Kelme sync: test alert",
    `This is a manual test of the admin alert path (lib/admin-notify.ts), sent at ${new Date().toISOString()}.\n\n` +
      "If you're reading this, RESEND_API_KEY and ADMIN_NOTIFY_EMAIL are both set correctly wherever this ran.",
  );
}

async function sendAdminAlert(subject: string, text: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ADMIN_NOTIFY_EMAIL;
  const from = process.env.RESEND_FROM ?? "Kelme Team <noreply@kelmeteam.com>";
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  if (!to) throw new Error("ADMIN_NOTIFY_EMAIL is not set");

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend send failed: HTTP ${res.status} ${body}`);
  }
}

export interface SyncAlertInput {
  /** Stable id for this alert type — one dedup row per kind. */
  kind: string;
  /** Whether the condition is bad *this* check/cycle. */
  isBad: boolean;
  /** Required when isBad is true. */
  subject?: string;
  /** Required when isBad is true. */
  body?: string;
  /** How long a bad state must persist before re-sending a reminder (default 12h). */
  persistWindowMs?: number;
}

/**
 * Call every cycle/check regardless of outcome. Sends exactly once on the
 * good->bad transition, then again only after `persistWindowMs` has elapsed
 * since the last send while still bad. A good check clears the state, so
 * the next bad transition notifies immediately rather than waiting out a
 * stale window.
 */
export async function reportSyncAlert({
  kind,
  isBad,
  subject,
  body,
  persistWindowMs = DEFAULT_PERSIST_WINDOW_MS,
}: SyncAlertInput): Promise<void> {
  const now = new Date();
  const row = await prisma.syncAlert.findUnique({ where: { kind } });

  if (!isBad) {
    if (row?.active) {
      await prisma.syncAlert.update({
        where: { kind },
        data: { active: false, firstSeenAt: null, lastNotifiedAt: null },
      });
    }
    return;
  }

  const isNewTransition = !row?.active;
  // A prior attempt marked the state active but never got a send to
  // succeed (lastNotifiedAt still null) — retry every cycle, not just
  // after persistWindowMs, since we haven't actually notified anyone yet.
  const neverSuccessfullyNotified = !isNewTransition && !row?.lastNotifiedAt;
  const dueForReminder =
    !!row?.lastNotifiedAt && now.getTime() - row.lastNotifiedAt.getTime() >= persistWindowMs;

  if (!isNewTransition && !neverSuccessfullyNotified && !dueForReminder) return;

  if (!subject || !body) {
    throw new Error(`reportSyncAlert("${kind}"): subject/body are required when isBad is true`);
  }

  // Record the transition to "active" immediately — that's genuinely true
  // regardless of whether the email goes out. lastNotifiedAt, the dedup
  // clock, is only set below on a *successful* send, so a failed send
  // (e.g. missing RESEND_API_KEY) retries next cycle instead of going
  // silent for a full persistWindowMs.
  await prisma.syncAlert.upsert({
    where: { kind },
    update: { active: true },
    create: { kind, active: true, firstSeenAt: now, lastNotifiedAt: null },
  });

  try {
    await sendAdminAlert(subject, body);
    await prisma.syncAlert.update({ where: { kind }, data: { lastNotifiedAt: now } });
  } catch (err) {
    console.error(`[admin-notify] alert email failed for "${kind}" — will retry next cycle: ${err instanceof Error ? err.message : String(err)}`);
  }
}
