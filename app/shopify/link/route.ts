import { NextRequest, NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import path from "path";
import { linkShopify } from "@/lib/shopify-link";
import { adminCookieName, isValidAdminToken } from "@/lib/admin-auth";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(adminCookieName())?.value;
  if (!isValidAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const report = await linkShopify();

    const outPath = path.join(process.cwd(), "shopify-link-report.json");
    await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");

    console.log(
      `[shopify/link] matched=${report.matchedCount} shopifyUnmatched=${report.shopifyUnmatched.length} kelmeUnmatched=${report.kelmeUnmatched.length} -> ${outPath}`,
    );

    return NextResponse.json({
      matched: report.matchedCount,
      shopifyUnmatched: report.shopifyUnmatched.length,
      kelmeUnmatched: report.kelmeUnmatched.length,
      file: "shopify-link-report.json",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[shopify/link] failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
