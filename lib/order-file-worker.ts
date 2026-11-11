/**
 * Worker side of order intake. The orders/paid webhook only inserts a PENDING
 * OrderFile; this claims those rows, audits the order, and emails the vendor
 * the order sheet. Runs on the Railway worker's short poll (worker/index.ts).
 *
 * Concurrency/crash model: claiming is one atomic UPDATE ... FOR UPDATE SKIP
 * LOCKED, so overlapping pollers never take the same row. A worker that dies
 * mid-row leaves it PROCESSING; once its lock is older than STALE_LOCK_MS it
 * is reclaimed. The vendor email carries Resend's Idempotency-Key
 * (order-file-<orderId>), so a reclaim after a send that actually succeeded
 * (inside Resend's idempotency window) can't deliver twice.
 */
import { Prisma, type OrderFile } from "@prisma/client";
import { prisma } from "./prisma";
import { shopifyGraphQL } from "./shopify";
import { sendEmail } from "./email";
import { sendAdminAlert } from "./admin-notify";
import { auditOrder, type TagsByProductId } from "./order-audit";
import { buildCsv, buildHtml, buildSubject, buildText, type VariantInfoBySku } from "./order-sheet";
import type { OrderLineItem, OrderPayload } from "./order-types";

export const MAX_ATTEMPTS = 5;
const STALE_LOCK_MS = 10 * 60 * 1000;
const CLAIM_BATCH = 5;
const TAG_BATCH = 100;

// --- Shopify lookups -----------------------------------------------------------

/** Product tags for the given numeric product ids, batched. Deleted products are absent from the map. */
export async function fetchProductTags(productIds: number[]): Promise<TagsByProductId> {
  const out: TagsByProductId = new Map();
  const unique = [...new Set(productIds)];
  for (let i = 0; i < unique.length; i += TAG_BATCH) {
    const ids = unique.slice(i, i + TAG_BATCH).map((id) => `gid://shopify/Product/${id}`);
    const res = await shopifyGraphQL<{ nodes: ({ id: string; tags: string[] } | null)[] }>(
      `query productTags($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id tags } } }`,
      { ids },
    );
    if (res.errors?.length) throw new Error(`product tags query failed: ${res.errors.map((e) => e.message).join("; ")}`);
    for (const node of res.data?.nodes ?? []) {
      if (node?.id) out.set(Number(node.id.split("/").pop()), node.tags);
    }
  }
  return out;
}

async function loadVariantInfo(lines: OrderLineItem[]): Promise<VariantInfoBySku> {
  const skus = [...new Set(lines.map((l) => l.sku).filter((s): s is string => !!s))];
  const info: VariantInfoBySku = new Map();
  if (skus.length === 0) return info;
  const variants = await prisma.variant.findMany({
    where: { sku: { in: skus } },
    select: { sku: true, colorName: true, shopifySize: true, kelmeSize: true, product: { select: { styleCode: true } } },
  });
  for (const v of variants) {
    info.set(v.sku, { styleCode: v.product.styleCode, colorName: v.colorName, size: v.shopifySize, kelmeSize: v.kelmeSize });
  }
  return info;
}

// --- processing ------------------------------------------------------------------

export async function processOrderFile(row: OrderFile): Promise<void> {
  const order = row.payload as unknown as OrderPayload;
  const vendor = process.env.KELME_VENDOR_EMAIL;
  if (!vendor) throw new Error("KELME_VENDOR_EMAIL is not set");

  const tags = await fetchProductTags(order.line_items.map((l) => l.product_id).filter((id): id is number => id != null));
  const audit = auditOrder(order, tags);
  const info = await loadVariantInfo([...audit.coreLines, ...audit.otherLines]);

  const subject = buildSubject(order, audit);
  const csv = buildCsv(order, audit, info);
  const { id } = await sendEmail({
    to: vendor,
    cc: process.env.ADMIN_NOTIFY_EMAIL || undefined,
    subject,
    html: buildHtml(order, audit, info),
    text: buildText(order, audit, info),
    attachments: [{ filename: `order-${order.name.replace(/[^\w-]/g, "")}.csv`, content: csv, contentType: "text/csv" }],
    idempotencyKey: `order-file-${row.shopifyOrderId}`,
  });

  await prisma.orderFile.update({
    where: { id: row.id },
    data: {
      status: "SENT",
      sentAt: new Date(),
      resendEmailId: id ?? null,
      auditFlags: audit.flags as unknown as Prisma.InputJsonValue,
      lastError: null,
      lockedAt: null,
    },
  });
}

// --- claiming ----------------------------------------------------------------------

async function claimBatch(): Promise<OrderFile[]> {
  const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
  return prisma.$queryRaw<OrderFile[]>`
    UPDATE "OrderFile"
       SET "status" = 'PROCESSING', "lockedAt" = now(), "attempts" = "attempts" + 1
     WHERE "id" IN (
       SELECT "id" FROM "OrderFile"
        WHERE ("status" = 'PENDING' OR ("status" = 'PROCESSING' AND "lockedAt" < ${staleBefore}))
          AND "attempts" < ${MAX_ATTEMPTS}
        ORDER BY "id"
        LIMIT ${CLAIM_BATCH}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING *`;
}

/** Rows whose worker died on the final allowed attempt never get re-claimed — fail them. */
async function failExhaustedStale(): Promise<OrderFile[]> {
  const staleBefore = new Date(Date.now() - STALE_LOCK_MS);
  return prisma.$queryRaw<OrderFile[]>`
    UPDATE "OrderFile"
       SET "status" = 'FAILED', "lastError" = COALESCE("lastError", 'worker stopped mid-processing on the final attempt')
     WHERE "status" = 'PROCESSING' AND "lockedAt" < ${staleBefore} AND "attempts" >= ${MAX_ATTEMPTS}
    RETURNING *`;
}

async function alertFailed(row: OrderFile, error: string): Promise<void> {
  try {
    await sendAdminAlert(
      `Order ${row.orderName}: vendor order sheet FAILED`,
      `The order sheet for ${row.orderName} (Shopify id ${row.shopifyOrderId}) could not be sent after ${row.attempts} attempts.\n\n` +
        `Last error: ${error}\n\nThe vendor has NOT received it. The row is status FAILED in OrderFile; ` +
        `set it back to PENDING (and attempts to 0) to retry once the cause is fixed.`,
    );
  } catch (err) {
    console.error(`[order-file] failed to send FAILED alert for ${row.orderName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One poll: reclaim/claim PENDING rows and process each. Returns how many were handled. */
export async function pollOrderFiles(log: (m: string) => void = console.log): Promise<number> {
  for (const row of await failExhaustedStale()) {
    log(`order-file: ${row.orderName} FAILED (stale on final attempt)`);
    await alertFailed(row, row.lastError ?? "stale lock on final attempt");
  }

  const claimed = await claimBatch();
  for (const row of claimed) {
    try {
      await processOrderFile(row);
      log(`order-file: ${row.orderName} sent (attempt ${row.attempts})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const final = row.attempts >= MAX_ATTEMPTS;
      log(`order-file: ${row.orderName} attempt ${row.attempts}/${MAX_ATTEMPTS} failed: ${message}`);
      await prisma.orderFile.update({
        where: { id: row.id },
        data: { status: final ? "FAILED" : "PENDING", lastError: message.slice(0, 2000), lockedAt: null },
      });
      if (final) await alertFailed(row, message);
    }
  }
  return claimed.length;
}
