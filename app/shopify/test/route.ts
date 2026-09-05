import { NextRequest, NextResponse } from "next/server";
import { shopifyAdminFetch } from "@/lib/shopify";
import { adminCookieName, isValidAdminToken } from "@/lib/admin-auth";

export async function GET(req: NextRequest) {
  const token = req.cookies.get(adminCookieName())?.value;
  if (!isValidAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let res: Response;
  try {
    res = await shopifyAdminFetch("/products.json?limit=5");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[shopify/test] request failed before reaching Shopify: ${message}`);
    return NextResponse.json({ error: message }, { status: 400 });
  }

  console.log(`[shopify/test] call status: ${res.status}`);

  const body = await res.text();
  return new NextResponse(body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
