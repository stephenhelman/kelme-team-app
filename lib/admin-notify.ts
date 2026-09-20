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
  const dueForReminder =
    !isNewTransition && !!row?.lastNotifiedAt && now.getTime() - row.lastNotifiedAt.getTime() >= persistWindowMs;

  if (!isNewTransition && !dueForReminder) return;

  if (!subject || !body) {
    throw new Error(`reportSyncAlert("${kind}"): subject/body are required when isBad is true`);
  }

  await prisma.syncAlert.upsert({
    where: { kind },
    update: { active: true, lastNotifiedAt: now },
    create: { kind, active: true, firstSeenAt: now, lastNotifiedAt: now },
  });

  try {
    await sendAdminAlert(subject, body);
  } catch (err) {
    console.error(`[admin-notify] alert email failed for "${kind}": ${err instanceof Error ? err.message : String(err)}`);
  }
}
