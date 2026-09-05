import { NextRequest, NextResponse } from "next/server";
import { dryRunReconcile, executeReconcile, batchReconcile, checkMatchingIntegrity } from "@/lib/shopify-reconcile";
import { adminCookieName, isValidAdminToken } from "@/lib/admin-auth";

// Gated: ?mode=dry-run|execute|batch|integrity-check. dry-run and execute
// take &styleCode=... (and optional &title=... to disambiguate).
// integrity-check surveys every DB product read-only. batch takes no params
// and runs across every DB product, logging to shopify-reconcile-log.jsonl
// for resumability.
export async function GET(req: NextRequest) {
  const token = req.cookies.get(adminCookieName())?.value;
  if (!isValidAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode") ?? "dry-run";
  const styleCode = searchParams.get("styleCode") ?? undefined;
  const title = searchParams.get("title") ?? undefined;

  try {
    if (mode === "dry-run") {
      if (!styleCode) throw new Error("styleCode is required for mode=dry-run");
      const result = await dryRunReconcile(styleCode, title);
      return NextResponse.json(result);
    }

    if (mode === "execute") {
      if (!styleCode) throw new Error("styleCode is required for mode=execute");
      const result = await executeReconcile(styleCode, title);
      return NextResponse.json(result);
    }

    if (mode === "batch") {
      const result = await batchReconcile();
      return NextResponse.json(result);
    }

    if (mode === "integrity-check") {
      const result = await checkMatchingIntegrity();
      return NextResponse.json(result);
    }

    throw new Error(`Unknown mode "${mode}" — use dry-run, execute, batch, or integrity-check`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[shopify/reconcile] failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
