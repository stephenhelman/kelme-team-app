import { NextRequest, NextResponse } from "next/server";
import { pullLiveStock, sampleStock, applyStockToDb } from "@/lib/kelme-inventory";
import { dryRunPush, executePush, verifyPush, confirmLocation } from "@/lib/shopify-inventory-push";
import { adminCookieName, isValidAdminToken } from "@/lib/admin-auth";

// Gated: ?mode=pull-dry|apply|push-dry-run|push-execute|verify|location.
//   pull-dry     — Stage 1 only. Live Kelme pull, no DB writes. Returns a
//                  sample spread across the pulled list + aggregate stats
//                  (total qty, zero vs stocked counts) to eyeball for
//                  garbage before touching the DB.
//   apply        — Stages 1+2. Re-pulls fresh, then writes qty onto
//                  EXISTING onShopify:true Variant rows only (a declared
//                  color/size with no DB match is reported unmatched, never
//                  created). Halts without writing if the pulled total is
//                  suspiciously low vs. the current DB total.
//   push-dry-run — Stage 3 dry-run. Confirms the inventory location, diffs
//                  DB qty against live Shopify on_hand + tracked flag,
//                  flags suspicious lots-of-stock-to-0 drops.
//   push-execute — Stage 3 execute. Enables tracking where needed, then
//                  sets absolute on_hand quantities via
//                  inventorySetQuantities, chunked/rate-limited. Recomputes
//                  candidates fresh each call (no cross-run skip — safe to
//                  re-run, SET is idempotent). Optional &chunkSize=N
//                  processes only the first N of this run's candidates
//                  (omit for "all"), logging to
//                  shopify-inventory-push-log.jsonl for audit.
//   verify       — re-pulls from Shopify, confirms every checked variant's
//                  on_hand matches DB qty.
//   location     — just the location confirmation, on its own.
export async function GET(req: NextRequest) {
  const token = req.cookies.get(adminCookieName())?.value;
  if (!isValidAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode") ?? "pull-dry";
  const chunkSizeParam = searchParams.get("chunkSize");
  const sampleSizeParam = searchParams.get("sampleSize");

  try {
    if (mode === "pull-dry") {
      const report = await pullLiveStock();
      const sampleSize = sampleSizeParam ? Number(sampleSizeParam) : undefined;
      const { pulled, ...summary } = report;
      return NextResponse.json({ ...summary, sample: sampleStock(report, sampleSize) });
    }

    if (mode === "apply") {
      const result = await applyStockToDb();
      return NextResponse.json(result);
    }

    if (mode === "push-dry-run") {
      const result = await dryRunPush();
      return NextResponse.json(result);
    }

    if (mode === "push-execute") {
      const chunkSize = chunkSizeParam ? Number(chunkSizeParam) : undefined;
      if (chunkSizeParam && (!Number.isFinite(chunkSize) || chunkSize! <= 0)) {
        throw new Error(`Invalid chunkSize "${chunkSizeParam}"`);
      }
      const result = await executePush(chunkSize);
      return NextResponse.json(result);
    }

    if (mode === "verify") {
      const result = await verifyPush();
      return NextResponse.json(result);
    }

    if (mode === "location") {
      const result = await confirmLocation();
      return NextResponse.json(result);
    }

    throw new Error(`Unknown mode "${mode}" — use pull-dry, apply, push-dry-run, push-execute, verify, or location`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[inventory/push] failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
