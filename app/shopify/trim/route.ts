import { NextRequest, NextResponse } from "next/server";
import { dryRunTrim, executeTrim } from "@/lib/shopify-trim";
import type { BaseGroup } from "@/lib/shopify-split";
import { adminCookieName, isValidAdminToken } from "@/lib/admin-auth";

const VALID_GROUPS = new Set(["Black Base", "White Base", "Other"]);

// Gated: ?mode=dry-run|execute. Both require &styleCode=...&shopifyProductId=...&group=...
// (group is one of "Black Base" | "White Base" | "Other") — these
// duplicate products can't be matched by styleCode-in-title (all 3
// duplicates share it), so the product ID must be explicit.
export async function GET(req: NextRequest) {
  const token = req.cookies.get(adminCookieName())?.value;
  if (!isValidAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode") ?? "dry-run";
  const styleCode = searchParams.get("styleCode");
  const shopifyProductIdParam = searchParams.get("shopifyProductId");
  const group = searchParams.get("group");

  try {
    if (!styleCode) throw new Error("styleCode is required");
    if (!shopifyProductIdParam) throw new Error("shopifyProductId is required");
    if (!group || !VALID_GROUPS.has(group)) throw new Error(`group must be one of: ${[...VALID_GROUPS].join(", ")}`);
    const shopifyProductId = Number(shopifyProductIdParam);
    if (!Number.isFinite(shopifyProductId)) throw new Error(`Invalid shopifyProductId "${shopifyProductIdParam}"`);

    if (mode === "dry-run") {
      const result = await dryRunTrim(styleCode, shopifyProductId, group as BaseGroup);
      return NextResponse.json(result);
    }

    if (mode === "execute") {
      const result = await executeTrim(styleCode, shopifyProductId, group as BaseGroup);
      return NextResponse.json(result);
    }

    throw new Error(`Unknown mode "${mode}" — use dry-run or execute`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[shopify/trim] failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
