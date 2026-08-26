import { NextResponse } from "next/server";
import { syncFromKelme } from "@/lib/kelme-sync";

// Manual "Refresh from Kelme" button — never automatic, no cron.
export async function POST() {
  try {
    const result = await syncFromKelme();
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Refresh failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
