/**
 * Tracked draft creation: wraps executeDraft with the DraftJob lock so a
 * re-run (manual or the daily job) can never create a duplicate or silently
 * retry a failure.
 *
 *   no row            -> insert CREATING (unique styleCode = the lock), create
 *   CREATED           -> skipped
 *   CREATING / FAILED -> skipped, needs a human: `drafts create --styleCode X --execute --resume`
 *   BLOCKED           -> nothing was written to Shopify last time; evaluated again
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { executeDraft, PartialDraftError, type VerifyReport } from "@/lib/shopify-draft";
import type { CategoryMap } from "@/lib/draft-rules";
import type { DraftEmailItem } from "@/lib/draft-email";

export type JobDecision = "create" | "skip-created" | "skip-needs-human" | "resume";

/** Pure: what the lock says to do for a style given its current job row. */
export function decideJob(existing: { status: string } | null, resume: boolean): JobDecision {
  if (existing?.status === "CREATED") return "skip-created";
  // An explicit --resume always continues the existing draft, whatever the job row says
  // (FAILED / CREATING, or BLOCKED by an earlier resume attempt, or no row for a draft made before the lock existed).
  if (resume) return "resume";
  if (!existing || existing.status === "BLOCKED") return "create";
  // CREATING (interrupted / another runner) or FAILED (partial draft): never retried automatically.
  return "skip-needs-human";
}

export interface JobOutcome {
  styleCode: string;
  status: "created" | "skipped" | "blocked" | "failed";
  message?: string;
  productGid?: string;
  emailItem?: DraftEmailItem;
  verify?: VerifyReport;
}

export async function createDraftTracked(styleCode: string, opts: { runId: number; categoryMap?: CategoryMap; resume?: boolean }): Promise<JobOutcome> {
  const existing = await prisma.draftJob.findUnique({ where: { styleCode } });
  const decision = decideJob(existing, opts.resume === true);
  if (decision === "skip-created") return { styleCode, status: "skipped", message: "already created", productGid: existing?.productGid ?? undefined };
  if (decision === "skip-needs-human") {
    return { styleCode, status: "skipped", message: `a previous attempt is ${existing!.status}${existing!.error ? ` (${existing!.error.slice(0, 160)})` : ""} — needs a person: npm run drafts -- create --styleCode ${styleCode} --execute --resume`, productGid: existing?.productGid ?? undefined };
  }

  // Take the lock.
  try {
    if (!existing) {
      await prisma.draftJob.create({ data: { styleCode, status: "CREATING", runId: opts.runId } });
    } else {
      // BLOCKED rows are re-taken atomically: only one runner can flip BLOCKED -> CREATING.
      const took = await prisma.draftJob.updateMany({ where: { styleCode, status: existing.status }, data: { status: "CREATING", runId: opts.runId, error: null } });
      if (took.count !== 1) return { styleCode, status: "skipped", message: "another runner holds this style" };
    }
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { styleCode, status: "skipped", message: "another runner holds this style" };
    throw e;
  }

  try {
    const r = await executeDraft(styleCode, { resume: decision === "resume", categoryMap: opts.categoryMap });
    if (r.verify.problems.length > 0) {
      const msg = `created ${r.productId} but verification found: ${r.verify.problems.slice(0, 5).join("; ")}`;
      await prisma.draftJob.update({ where: { styleCode }, data: { status: "FAILED", productGid: r.productId, error: msg.slice(0, 1000), summary: r.emailItem as unknown as Prisma.InputJsonValue } });
      return { styleCode, status: "failed", message: msg, productGid: r.productId, emailItem: r.emailItem, verify: r.verify };
    }
    await prisma.draftJob.update({ where: { styleCode }, data: { status: "CREATED", productGid: r.productId, error: null, summary: r.emailItem as unknown as Prisma.InputJsonValue } });
    return { styleCode, status: "created", productGid: r.productId, emailItem: r.emailItem, verify: r.verify };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof PartialDraftError) {
      await prisma.draftJob.update({ where: { styleCode }, data: { status: "FAILED", productGid: err.productGid, error: message.slice(0, 1000) } });
      return { styleCode, status: "failed", message: `partial draft ${err.productGid}: ${message}`, productGid: err.productGid };
    }
    // Thrown before anything was written to Shopify ("Cannot execute —", Kelme capture trouble): safe to evaluate again next time.
    const blocked = message.startsWith("Cannot execute —") || message.includes("Kelme re-capture failed");
    const sessionDead = message.includes("session expired");
    await prisma.draftJob.update({ where: { styleCode }, data: { status: blocked || sessionDead ? "BLOCKED" : "FAILED", error: message.slice(0, 1000) } });
    return { styleCode, status: blocked || sessionDead ? "blocked" : "failed", message };
  }
}

/** Email items for the CREATED jobs of one run (what the vendor is told). */
export async function runEmailItems(runId: number): Promise<DraftEmailItem[]> {
  const jobs = await prisma.draftJob.findMany({ where: { runId, status: "CREATED" }, orderBy: { styleCode: "asc" } });
  return jobs.flatMap((j) => (j.summary ? [j.summary as unknown as DraftEmailItem] : []));
}
