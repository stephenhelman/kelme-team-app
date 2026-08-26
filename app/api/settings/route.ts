import { NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";

// Public read of the shipping/minimum settings the cart needs to render totals.
export async function GET() {
  const settings = await getSettings();
  return NextResponse.json(settings);
}
