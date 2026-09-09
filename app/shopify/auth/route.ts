import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { shopifyAuthorizeUrl, verifyShopifyOAuthRequest } from "@/lib/shopify";

const STATE_COOKIE = "shopify_oauth_state";

// Entered by Shopify itself (redirect from admin.shopify.com on install/
// re-auth), which never carries our admin cookie — so this is gated on
// Shopify's own hmac signature, not the admin-cookie gate the other routes
// use. See lib/shopify.ts's verifyShopifyOAuthRequest.
export async function GET(req: NextRequest) {
  if (!verifyShopifyOAuthRequest(req.nextUrl.searchParams)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const state = randomBytes(16).toString("hex");
  const baseUrl = process.env.SHOPIFY_APP_URL ?? req.nextUrl.origin;
  const redirectUri = new URL("/shopify/callback", baseUrl).toString();
  const authorizeUrl = shopifyAuthorizeUrl(redirectUri, state);

  console.log(`[shopify/auth] redirect built -> ${authorizeUrl}`);

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10,
  });
  return res;
}
