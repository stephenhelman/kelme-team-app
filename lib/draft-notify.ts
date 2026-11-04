/**
 * Client notification for drafts the pipeline has created. Deliberately a
 * separate step from creation: it only ever covers products whose
 * `--execute` run logged a clean verification (shopify-drafts-log.jsonl), it
 * is a dry-run unless sent explicitly, and it records what was sent so the
 * client is never emailed about the same product twice (unless forced).
 */
import { readFile } from "fs/promises";
import { DRAFT_LOG_PATH, logDraftEvent, planDraft, verifyDraft } from "@/lib/shopify-draft";
import type { AddedProduct } from "@/lib/product-added-notify";

interface LogRow {
  styleCode: string;
  step: string;
  productGid?: string;
  problems?: string[];
}

async function readLog(): Promise<LogRow[]> {
  let raw = "";
  try {
    raw = await readFile(DRAFT_LOG_PATH, "utf8");
  } catch {
    return [];
  }
  const rows: LogRow[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as LogRow);
    } catch {
      // skip malformed line
    }
  }
  return rows;
}

export interface NotifyCandidates {
  /** styleCode -> product gid, for drafts whose execute run verified clean. */
  verified: Map<string, string>;
  /** product gids already emailed to the client. */
  notified: Set<string>;
}

export async function loadNotifyState(): Promise<NotifyCandidates> {
  const rows = await readLog();
  const verified = new Map<string, string>();
  const notified = new Set<string>();
  for (const r of rows) {
    if (r.step === "verify" && r.productGid && (r.problems?.length ?? 0) === 0) verified.set(r.styleCode, r.productGid);
    if (r.step === "notified" && r.productGid) notified.add(r.productGid);
  }
  return { verified, notified };
}

export interface NotifySelection {
  products: AddedProduct[];
  skipped: { styleCode: string; reason: string }[];
}

// Builds the email rows from LIVE Shopify state (so the numbers are what the
// client will actually see), for the requested style codes — or, with
// `unnotified`, every verified draft not yet emailed.
export async function buildNotifySelection(opts: { styleCodes?: string[]; unnotified?: boolean; force?: boolean }): Promise<NotifySelection> {
  const state = await loadNotifyState();
  const codes = opts.unnotified
    ? [...state.verified.entries()].filter(([, gid]) => !state.notified.has(gid)).map(([code]) => code)
    : (opts.styleCodes ?? []);
  const products: AddedProduct[] = [];
  const skipped: NotifySelection["skipped"] = [];

  for (const styleCode of codes) {
    const gid = state.verified.get(styleCode);
    if (!gid) {
      skipped.push({ styleCode, reason: "no clean --execute run logged for this style code (not created by the pipeline, or verification had problems)" });
      continue;
    }
    if (state.notified.has(gid) && !opts.force) {
      skipped.push({ styleCode, reason: "client already notified about this product (use --force to resend)" });
      continue;
    }
    const plan = await planDraft(styleCode);
    const live = plan.existingOnShopify.find((e) => e.id === gid);
    if (!live) {
      skipped.push({ styleCode, reason: `logged product ${gid} no longer found on Shopify` });
      continue;
    }
    const v = await verifyDraft(gid, plan);
    products.push({
      title: v.title,
      styleCode,
      shopifyProductId: gid,
      status: v.status,
      category: v.category,
      variantCount: v.variantCount,
      colorCount: plan.colorValues.length,
      sizes: plan.sizeValues.map((s) => s.name),
      imagesAttached: v.imagesAttached,
      totalQty: plan.variants.reduce((n, x) => n + x.qty, 0),
      variantsInStock: plan.variants.filter((x) => x.qty > 0).length,
      price: v.perVariant[0]?.price ?? plan.price,
      needsPricing: v.tags.some((t) => t.toLowerCase() === "needs-pricing"),
    });
  }
  return { products, skipped };
}

export async function recordNotified(products: AddedProduct[], to: string, resendId?: string): Promise<void> {
  for (const p of products) {
    await logDraftEvent({ styleCode: p.styleCode, step: "notified", productGid: p.shopifyProductId, to, resendId });
  }
}
