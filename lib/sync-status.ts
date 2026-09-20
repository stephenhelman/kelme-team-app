/**
 * Heartbeat for the sync worker — singleton row (id 1) recording when a full
 * sync cycle last completed successfully (no halt, no thrown error). This is
 * what the /api/cron/heartbeat staleness check reads: an error-notification
 * can only fire when something goes wrong loudly, but the worker being
 * down/hung produces no error at all, only silence — this timestamp is what
 * catches that.
 */
import { prisma } from "./prisma";

export async function recordSuccessfulSync(): Promise<void> {
  const now = new Date();
  await prisma.syncStatus.upsert({
    where: { id: 1 },
    update: { lastSuccessfulSyncAt: now },
    create: { id: 1, lastSuccessfulSyncAt: now },
  });
}

export async function getLastSuccessfulSyncAt(): Promise<Date | null> {
  const row = await prisma.syncStatus.findUnique({ where: { id: 1 } });
  return row?.lastSuccessfulSyncAt ?? null;
}
