/**
 * The daily "favorites -> drafts" job for the Railway worker. Same engine and
 * rules as `drafts create --all` (lib/draft-run.ts); this file only adds the
 * safeguards around it:
 *
 *   AUTO_DRAFTS_ENABLED   must be exactly "true" (default off)
 *   MAX_DRAFTS_PER_RUN    default 15; extra favorites wait for the next run and the admin is told
 *   once a day           an attempt row (DraftRun) is written before any network call, so even a
 *                        crash cannot make the job retry in a loop
 *   any failure          admin alert, the run stops, the style is marked FAILED and is never
 *                        retried automatically (a person runs `drafts create --styleCode X --execute --resume`)
 *   un-favorited         nothing happens (they are simply not in the favorites list)
 *   email                one vendor email listing only THIS run's new drafts; none if nothing new
 */
import { prisma } from "@/lib/prisma";
import { runDrafts, type RunReport } from "@/lib/draft-run";
import { runEmailItems } from "@/lib/draft-jobs";
import { sendNewDraftsEmail } from "@/lib/draft-email";
import { reportSyncAlert, sendAdminAlert } from "@/lib/admin-notify";
import { shopDomain } from "@/lib/shopify";
import { missingColorsAlertBody } from "@/lib/color-seed";

export const DEFAULT_MAX_DRAFTS_PER_RUN = 15;
const MIN_GAP_MS = 23 * 60 * 60 * 1000;

export function autoConfigFromEnv(env: Record<string, string | undefined>): { enabled: boolean; cap: number } {
  const n = Number(env.MAX_DRAFTS_PER_RUN);
  return { enabled: env.AUTO_DRAFTS_ENABLED === "true", cap: Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_DRAFTS_PER_RUN };
}

/** Pure: has it been long enough since the last automatic attempt (successful or not)? */
export function dueForRun(lastAttemptAt: Date | null, now: Date, minGapMs = MIN_GAP_MS): boolean {
  return !lastAttemptAt || now.getTime() - lastAttemptAt.getTime() >= minGapMs;
}

export interface PlannedAlert {
  kind: string;
  isBad: boolean;
  subject?: string;
  body?: string;
  persistWindowMs?: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Pure: which admin alerts a finished run calls for. Each `kind` is deduped by reportSyncAlert (clears when good). */
export function alertsFor(report: RunReport, cap: number): PlannedAlert[] {
  const lines = (xs: { styleCode: string; message?: string; status?: string }[]) => xs.map((x) => `- ${x.styleCode}: ${x.message ?? x.status ?? ""}`).join("\n");
  return [
    {
      kind: "auto_drafts_failure",
      isBad: report.failed.length > 0 || report.stoppedReason !== null,
      subject: "Auto drafts: a failure stopped the run",
      body: `The daily favorites->drafts run (#${report.runId}) stopped:\n\n${report.stoppedReason ?? ""}\n\n${lines(report.failed)}\n\nNothing is retried automatically. Fix the cause, then: npm run drafts -- create --styleCode <code> --execute --resume (or re-run \`create --all --execute\`; finished styles are skipped).`,
    },
    {
      kind: "auto_drafts_over_cap",
      isBad: report.overCap.length > 0,
      subject: `Auto drafts: ${report.overCap.length} more favorite(s) waiting (cap ${cap} per run)`,
      body: `Run #${report.runId} created up to the cap of ${cap}. ${report.overCap.length} favorite(s) are still waiting and will be picked up by the next daily run:\n\n${report.overCap.join(", ")}\n\nRaise MAX_DRAFTS_PER_RUN, or run \`npm run drafts -- create --all --execute\` yourself.`,
      persistWindowMs: 24 * 60 * 60 * 1000,
    },
    {
      kind: "auto_drafts_new_colors",
      isBad: report.missingColors.length > 0,
      subject: `Auto drafts: ${report.missingColors.length} new Kelme color(s) need a Shopify color value`,
      body: missingColorsAlertBody(report.missingColors),
      persistWindowMs: 3 * 24 * 60 * 60 * 1000,
    },
    {
      kind: "auto_drafts_blocked",
      isBad: report.blocked.length > 0,
      subject: `Auto drafts: ${report.blocked.length} favorite(s) could not be drafted`,
      body: `Blocked (nothing was created for these; they are re-checked each day):\n\n${lines(report.blocked)}`,
      persistWindowMs: WEEK_MS,
    },
    {
      kind: "auto_drafts_stuck",
      isBad: report.needsHuman.length > 0,
      subject: `Auto drafts: ${report.needsHuman.length} style(s) need a person`,
      body: `These styles have an interrupted or failed earlier attempt and are never retried automatically:\n\n${lines(report.needsHuman)}\n\nResume each with: npm run drafts -- create --styleCode <code> --execute --resume`,
      persistWindowMs: WEEK_MS,
    },
  ];
}

export async function runAutoDraftsOnce(log: (m: string) => void, env: Record<string, string | undefined> = process.env): Promise<"disabled" | "not-due" | "ran"> {
  const { enabled, cap } = autoConfigFromEnv(env);
  if (!enabled) return "disabled";
  const last = await prisma.draftRun.findFirst({ where: { source: "auto" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
  if (!dueForRun(last?.startedAt ?? null, new Date())) return "not-due";

  // Attempt marker first: from here on, one attempt per day no matter what happens.
  const attempt = await prisma.draftRun.create({ data: { source: "auto" } });
  log(`auto-drafts: run ${attempt.id} starting (cap ${cap})`);
  try {
    const report = await runDrafts({ source: "auto", cap, runId: attempt.id, log });
    log(`auto-drafts: run ${report.runId} created=${report.created.length} blocked=${report.blocked.length} failed=${report.failed.length} overCap=${report.overCap.length} needsHuman=${report.needsHuman.length}${report.stoppedReason ? ` STOPPED: ${report.stoppedReason}` : ""}`);

    if (report.created.length > 0) {
      try {
        const items = await runEmailItems(report.runId);
        if (items.length > 0) {
          const sent = await sendNewDraftsEmail(items, { adminBaseUrl: `https://${shopDomain()}/admin`, runId: report.runId });
          await prisma.draftRun.update({ where: { id: report.runId }, data: { emailedAt: new Date(), emailedTo: sent.to } });
          log(`auto-drafts: emailed ${items.length} draft(s) to ${sent.to}`);
        }
      } catch (err) {
        // Not retried (the drafts exist and are recorded); `drafts email --run <id> --send` sends it by hand.
        const message = err instanceof Error ? err.message : String(err);
        log(`auto-drafts: vendor email failed: ${message}`);
        await sendAdminAlert(`Auto drafts: vendor email failed for run ${report.runId}`, `The drafts were created but the email did not send:\n\n${message}\n\nSend it by hand: npm run drafts -- email --run ${report.runId} --send`).catch(() => undefined);
      }
    } else {
      log("auto-drafts: nothing new — no email");
    }

    for (const a of alertsFor(report, cap)) await reportSyncAlert(a).catch((e) => log(`auto-drafts: alert ${a.kind} failed: ${e instanceof Error ? e.message : e}`));
    return "ran";
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`auto-drafts: FAILED: ${message}`);
    await prisma.draftRun.update({ where: { id: attempt.id }, data: { finishedAt: new Date(), stoppedReason: message.slice(0, 500) } }).catch(() => undefined);
    await reportSyncAlert({ kind: "auto_drafts_failure", isBad: true, subject: "Auto drafts: the daily run failed", body: `The daily favorites->drafts run (#${attempt.id}) threw:\n\n${message}\n\nIt will NOT retry until tomorrow's run. Nothing was emailed to the vendor.` }).catch(() => undefined);
    return "ran";
  }
}
