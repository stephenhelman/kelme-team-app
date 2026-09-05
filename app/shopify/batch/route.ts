import { NextRequest, NextResponse } from "next/server";
import { dryRunBatch, executeBatch, runBatch } from "@/lib/shopify-batch";
import { adminCookieName, isValidAdminToken } from "@/lib/admin-auth";

// Gated: ?mode=dry-run|execute|batch. dry-run and execute take
// &styleCode=... — dry-run never writes; execute runs the full
// reconcile -> reorder -> media -> tags sequence for one product, refusing
// to run on a skipped (unmatched or audience-ambiguous) product. batch
// takes an optional &chunkSize=N (omit for "all remaining") and
// &forceStyleCodes=a,b,c (bypasses the resumable skip for those specific
// codes), logging to shopify-batch-log.jsonl.
export async function GET(req: NextRequest) {
  const token = req.cookies.get(adminCookieName())?.value;
  if (!isValidAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode") ?? "dry-run";
  const styleCode = searchParams.get("styleCode") ?? undefined;
  const chunkSizeParam = searchParams.get("chunkSize");

  try {
    if (mode === "dry-run") {
      if (!styleCode) throw new Error("styleCode is required for mode=dry-run");
      const result = await dryRunBatch(styleCode);
      return NextResponse.json(result);
    }

    if (mode === "execute") {
      if (!styleCode) throw new Error("styleCode is required for mode=execute");
      const result = await executeBatch(styleCode);
      return NextResponse.json(result);
    }

    if (mode === "batch") {
      const chunkSize = chunkSizeParam ? Number(chunkSizeParam) : undefined;
      if (chunkSizeParam && (!Number.isFinite(chunkSize) || chunkSize! <= 0)) {
        throw new Error(`Invalid chunkSize "${chunkSizeParam}"`);
      }
      const forceParam = searchParams.get("forceStyleCodes");
      const forceStyleCodes = forceParam ? forceParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const result = await runBatch(chunkSize, forceStyleCodes);
      return NextResponse.json(result);
    }

    throw new Error(`Unknown mode "${mode}" — use dry-run, execute, or batch`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[shopify/batch] failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
