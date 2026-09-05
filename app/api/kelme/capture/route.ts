import { NextRequest, NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import path from "path";
import { adminCookieName, isValidAdminToken } from "@/lib/admin-auth";
import { captureAllFavorites } from "@/lib/kelme-capture";

export const maxDuration = 300;

const REPORT_PATH = path.join(process.cwd(), "kelme-capture-report.json");

// Server-side trigger for the Kelme capture — the token never reaches the
// browser. Admin-gated the same way the rest of the admin surface is.
//
// A full run can run well past typical client-side HTTP timeouts (300+
// products, paced calls). The report is written to disk before responding
// so a client that gives up waiting doesn't lose the result — read
// kelme-capture-report.json if the response itself times out.
export async function POST(req: NextRequest) {
  const token = req.cookies.get(adminCookieName())?.value;
  if (!isValidAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const report = await captureAllFavorites();
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
