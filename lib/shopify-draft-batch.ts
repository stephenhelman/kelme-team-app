/**
 * Batch driver over lib/shopify-draft.ts's single-product create. Selection
 * is pre-flight-driven (anything flagged is skipped, never forced); every
 * product is re-captured and re-checked by executeDraft before it is sent,
 * so a stale selection can't create a bad draft.
 *
 * Products run one at a time. The first failure (or a verification problem)
 * stops the run unless continueOnError is set — a systemic problem should not
 * be repeated across a dozen products. A dead Kelme session always stops it.
 * Successfully created products are returned for ONE summary email.
 */
import { prisma } from "@/lib/prisma";
import { loadRecordedDropNotes, runPreflight } from "@/lib/draft-preflight";
import { executeDraft, planDraft } from "@/lib/shopify-draft";
import type { AddedProduct } from "@/lib/product-added-notify";

const PRODUCT_PACING_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BatchSelection {
  selected: string[];
  skipped: { styleCode: string; reason: string }[];
}

// --all-clean: pre-flight-clean simple apparel (a real size dimension). Socks
// and other One-Size products (Color-only path) need includeNoSize — they are
// a separate, deliberate run. Needs-split products are never selected here.
export async function selectAllClean(opts: { includeNoSize: boolean }): Promise<BatchSelection> {
  const { notes, excluded, generatedAt } = await loadRecordedDropNotes();
  console.log(`using dropped-size notes from the pre-flight capture of ${generatedAt}`);
  const run = await runPreflight({ capture: false, knownDropNotes: notes, knownExcludedNotes: excluded });
  const selected: string[] = [];
  const skipped: BatchSelection["skipped"] = [];
  const deleted = new Set((await prisma.draftJob.findMany({ where: { status: "DELETED_BY_VENDOR" }, select: { styleCode: true } }).catch(() => [])).map((j) => j.styleCode));
  for (const r of run.results) {
    if (deleted.has(r.styleCode)) {
      skipped.push({ styleCode: r.styleCode, reason: "deleted by the vendor in Shopify (DELETED_BY_VENDOR) — never auto-recreated" });
      continue;
    }
    if (r.simpleApparel || (opts.includeNoSize && r.clean && !r.needsSplit)) selected.push(r.styleCode);
    else skipped.push({ styleCode: r.styleCode, reason: r.clean ? "clean but no size dimension (use --include-no-size)" : r.flags.join("; ") });
  }
  return { selected, skipped };
}

export interface DraftBatchOutcome {
  styleCode: string;
  status: "created" | "blocked" | "failed";
  message?: string;
  summary?: AddedProduct;
}

export interface DraftBatchResult {
  outcomes: DraftBatchOutcome[];
  stoppedEarly: string | null;
}

export async function dryRunDraftBatch(styleCodes: string[]): Promise<{ styleCode: string; blockers: string[]; variants: number; images: number; qty: number; title: string }[]> {
  const out = [];
  for (const styleCode of styleCodes) {
    const plan = await planDraft(styleCode);
    const blockers = [...plan.blockers];
    if (plan.existingOnShopify.length > 0) blockers.push(`already on Shopify: ${plan.existingOnShopify.map((e) => `${e.id} [${e.status}]`).join(", ")}`);
    out.push({
      styleCode,
      blockers,
      variants: plan.variants.length,
      images: plan.images.length,
      qty: plan.variants.reduce((n, v) => n + v.qty, 0),
      title: plan.title,
    });
  }
  return out;
}

export async function executeDraftBatch(styleCodes: string[], opts: { continueOnError: boolean }): Promise<DraftBatchResult> {
  const result: DraftBatchResult = { outcomes: [], stoppedEarly: null };
  for (let i = 0; i < styleCodes.length; i++) {
    const styleCode = styleCodes[i];
    console.log(`\n===== [${i + 1}/${styleCodes.length}] ${styleCode} =====`);
    try {
      const r = await executeDraft(styleCode);
      if (r.verify.problems.length > 0) {
        result.outcomes.push({ styleCode, status: "failed", message: `created ${r.productId} but verification found: ${r.verify.problems.join("; ")}` });
        if (!opts.continueOnError) {
          result.stoppedEarly = `verification problems on ${styleCode}`;
          break;
        }
      } else {
        result.outcomes.push({ styleCode, status: "created", summary: r.summary });
        console.log(`created ${r.productId} — verified OK`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const blocked = message.startsWith("Cannot execute —");
      result.outcomes.push({ styleCode, status: blocked ? "blocked" : "failed", message });
      console.error(`${blocked ? "blocked" : "FAILED"}: ${message}`);
      if (message.includes("session expired")) {
        result.stoppedEarly = "Kelme session expired — re-auth required";
        break;
      }
      if (!blocked && !opts.continueOnError) {
        result.stoppedEarly = `failure on ${styleCode} (a partial draft may exist: re-run create --styleCode ${styleCode} --execute --resume)`;
        break;
      }
    }
    await sleep(PRODUCT_PACING_MS);
  }
  return result;
}
