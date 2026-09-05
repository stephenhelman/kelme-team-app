import { NextRequest, NextResponse } from "next/server";
import { dryRunRelink, executeRelink } from "@/lib/shopify-relink";
import { adminCookieName, isValidAdminToken } from "@/lib/admin-auth";

// Gated: ?mode=dry-run|execute. Reconciles DB shopifyVariantId/shopifyInventoryItemId
// against live Shopify by (styleCode, colorCode, shopifySize) identity — never SKU.
export async function GET(req: NextRequest) {
  const token = req.cookies.get(adminCookieName())?.value;
  if (!isValidAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode") ?? "dry-run";

  try {
    if (mode === "dry-run") {
      const result = await dryRunRelink();
      const { _matches, _productOnShopify, ...report } = result;
      return NextResponse.json(report);
    }

    if (mode === "execute") {
      const result = await executeRelink();
      return NextResponse.json(result);
    }

    throw new Error(`Unknown mode "${mode}" — use dry-run or execute`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[shopify/relink] failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
