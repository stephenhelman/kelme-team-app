import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForToken, saveAccessToken, verifyShopifyOAuthRequest } from "@/lib/shopify";

const STATE_COOKIE = "shopify_oauth_state";

// Entered by Shopify itself (redirect_uri after merchant approval), which
// never carries our admin cookie — gated on Shopify's hmac signature
// instead, same as /shopify/auth. The state-cookie check below is a
// separate, unrelated CSRF guard (ours, not Shopify's) and stays either way.
export async function GET(req: NextRequest) {
  if (!verifyShopifyOAuthRequest(req.nextUrl.searchParams)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expectedState = req.cookies.get(STATE_COOKIE)?.value;

  if (!code || !state) {
    console.error("[shopify/callback] missing code or state in query");
    return NextResponse.json({ error: "Missing code or state" }, { status: 400 });
  }

  if (!expectedState || state !== expectedState) {
    console.error("[shopify/callback] state mismatch");
    return NextResponse.json({ error: "Invalid state" }, { status: 400 });
  }

  console.log("[shopify/callback] state verified");

  let accessToken: string;
  let scope: string;
  try {
    const result = await exchangeCodeForToken(code);
    accessToken = result.access_token;
    scope = result.scope;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[shopify/callback] token exchange failed: ${message}`);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  console.log(`[shopify/callback] token received (scope: ${scope})`);

  await saveAccessToken(accessToken, scope);

  const res = NextResponse.json({
    ok: true,
    message: "Shopify access token stored. Visit /shopify/test to verify.",
    scope,
  });
  res.cookies.delete(STATE_COOKIE);
  return res;
}
