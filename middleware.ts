import { NextRequest, NextResponse } from "next/server";
import { adminCookieName, isValidAdminToken } from "@/lib/admin-auth";

// Trivial shared-password gate for the prototype's admin portal — not real
// user auth (that's post-greenlight). Protects the /admin pages and the
// /api/admin/* routes they call.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname === "/admin/login" || pathname === "/api/admin/login") {
    return NextResponse.next();
  }

  const token = req.cookies.get(adminCookieName())?.value;
  if (isValidAdminToken(token)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/admin")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = req.nextUrl.clone();
  url.pathname = "/admin/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
