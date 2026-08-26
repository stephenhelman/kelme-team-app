import { NextResponse } from "next/server";

// Stub — real order-notification email is post-prototype. This just confirms
// the button works; nothing is actually sent.
export async function POST() {
  return NextResponse.json({ ok: true, simulated: true });
}
