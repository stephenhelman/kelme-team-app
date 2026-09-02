import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { shopifyAuthorizeUrl } from "@/lib/shopify";

const STATE_COOKIE = "shopify_oauth_state";

export async function GET(req: NextRequest) {
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
