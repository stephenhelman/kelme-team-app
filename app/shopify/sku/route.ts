import { NextRequest, NextResponse } from "next/server";
import { computeSkus, dryRunWrite, executeWrite, verifyWrite } from "@/lib/shopify-sku";
import { adminCookieName, isValidAdminToken } from "@/lib/admin-auth";

// Gated: ?mode=compute|dry-run|execute|verify.
//   compute  — computes buildSku for every onShopify:true DB variant, stores
//              it on Variant.sku, returns counts + a sample across variant
//              kinds. No Shopify calls.
//   dry-run  — read-only against Shopify: diffs stored DB skus against the
//              live variant sku via nodes(ids:), flags null shopifyVariantId.
//   execute  — writes only the mismatched variants via
//              productVariantsBulkUpdate, grouped by product, chunked to
//              100/call. Optional &chunkSize=N processes only N not-yet-
//              logged variants this call (omit for "all remaining"),
//              logging to shopify-sku-write-log.jsonl for resumability.
//   verify   — re-pulls from Shopify and confirms every onShopify:true
//              variant now carries its correct sku.
export async function GET(req: NextRequest) {
  const token = req.cookies.get(adminCookieName())?.value;
  if (!isValidAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode") ?? "compute";
  const chunkSizeParam = searchParams.get("chunkSize");

  try {
    if (mode === "compute") {
      const result = await computeSkus();
      return NextResponse.json(result);
    }

    if (mode === "dry-run") {
      const result = await dryRunWrite();
      return NextResponse.json(result);
    }

    if (mode === "execute") {
      const chunkSize = chunkSizeParam ? Number(chunkSizeParam) : undefined;
      if (chunkSizeParam && (!Number.isFinite(chunkSize) || chunkSize! <= 0)) {
        throw new Error(`Invalid chunkSize "${chunkSizeParam}"`);
      }
      const result = await executeWrite(chunkSize);
      return NextResponse.json(result);
    }

    if (mode === "verify") {
      const result = await verifyWrite();
      return NextResponse.json(result);
    }

    throw new Error(`Unknown mode "${mode}" — use compute, dry-run, execute, or verify`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[shopify/sku] failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
