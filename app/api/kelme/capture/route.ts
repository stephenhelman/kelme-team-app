import { NextRequest, NextResponse } from "next/server";
import { adminCookieName, isValidAdminToken } from "@/lib/admin-auth";
import { captureAllFavorites } from "@/lib/kelme-capture";

export const maxDuration = 800;

// Server-side trigger for the Kelme capture — the token never reaches the
// browser. Admin-gated the same way the rest of the admin surface is.
export async function POST(req: NextRequest) {
  const token = req.cookies.get(adminCookieName())?.value;
  if (!isValidAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const report = await captureAllFavorites();
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
