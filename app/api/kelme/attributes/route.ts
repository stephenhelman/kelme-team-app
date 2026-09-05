import { NextRequest, NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import path from "path";
import { adminCookieName, isValidAdminToken } from "@/lib/admin-auth";
import { captureAllProductAttributes } from "@/lib/kelme-attributes";

export const maxDuration = 300;

const REPORT_PATH = path.join(process.cwd(), "kelme-attributes-report.json");

// Server-side trigger for the b2b.pdt.detail attribute pull — same shape as
// /api/kelme/capture. Report is written to disk before responding since a
// full run (313 paced, retried calls) can outlast typical client timeouts.
export async function POST(req: NextRequest) {
  const token = req.cookies.get(adminCookieName())?.value;
  if (!isValidAdminToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const report = await captureAllProductAttributes();
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
