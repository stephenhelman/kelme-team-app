import { NextRequest, NextResponse } from "next/server";
import { dryRunTags, executeTags, batchTags } from "@/lib/shopify-tags";
import { adminCookieName, isValidAdminToken } from "@/lib/admin-auth";

// Gated: ?mode=dry-run|execute|batch. dry-run and execute take
// &styleCode=... (and optional &title=... to disambiguate). dry-run never
// writes; execute refuses to run on a flagged (ambiguous-audience or
// unmatched) product. batch takes an optional &chunkSize=N to process only
// N not-yet-logged products per call — omit for "all remaining" — logging
// to shopify-tags-log.jsonl for resumability across calls.
export async function GET(req: NextRequest) {
  const token = req.cookies.get(adminCookieName())?.value;
  if (!isValidAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode") ?? "dry-run";
  const styleCode = searchParams.get("styleCode") ?? undefined;
  const title = searchParams.get("title") ?? undefined;
  const chunkSizeParam = searchParams.get("chunkSize");

  try {
    if (mode === "dry-run") {
      if (!styleCode) throw new Error("styleCode is required for mode=dry-run");
      const result = await dryRunTags(styleCode, title);
      return NextResponse.json(result);
    }

    if (mode === "execute") {
      if (!styleCode) throw new Error("styleCode is required for mode=execute");
      const result = await executeTags(styleCode, title);
      return NextResponse.json(result);
    }

    if (mode === "batch") {
      const chunkSize = chunkSizeParam ? Number(chunkSizeParam) : undefined;
      if (chunkSizeParam && (!Number.isFinite(chunkSize) || chunkSize! <= 0)) {
        throw new Error(`Invalid chunkSize "${chunkSizeParam}"`);
      }
      const forceParam = searchParams.get("forceStyleCodes");
      const forceStyleCodes = forceParam ? forceParam.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
      const result = await batchTags(chunkSize, forceStyleCodes);
      return NextResponse.json(result);
    }

    throw new Error(`Unknown mode "${mode}" — use dry-run, execute, or batch`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[shopify/tags] failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
