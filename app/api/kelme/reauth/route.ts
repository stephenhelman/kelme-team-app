import { NextRequest, NextResponse } from "next/server";
import { attemptKelmeLogin, fetchKelmeCaptcha } from "@/lib/kelme-login";
import { seedKelmeToken } from "@/lib/kelme-token";

// Kelme captcha re-auth: this is the ONLY way a Kelme token enters
// KelmeToken (including the first bootstrap) — no manual seeding. GET
// issues a fresh captcha; POST completes the login and, on success, writes
// the token via lib/kelme-token.ts. A wrong/expired captcha never
// dead-ends — the response carries a fresh captcha to retry with.
//
// Ungated on purpose: this route is reached from the vendor re-auth email's
// link (lib/vendor-notify.ts), opened by the vendor directly — there's no
// admin session to check, and there's no other admin-side surface left in
// this app to protect. Kelme credentials never leave the server either way.

export async function GET() {
  try {
    const captcha = await fetchKelmeCaptcha();
    return NextResponse.json(captcha);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  const { pem, sign, code } = await req.json().catch(() => ({}));
  if (!pem || !sign || !code) {
    return NextResponse.json({ error: "Missing pem/sign/code" }, { status: 400 });
  }

  const result = await attemptKelmeLogin(pem, sign, code);

  if (!result.ok || !result.token) {
    // Captchas are single-use and time-limited — hand back a fresh one so
    // the client can retry instead of dead-ending on a bad guess.
    try {
      const captcha = await fetchKelmeCaptcha();
      return NextResponse.json(
        { error: result.error ?? "Kelme login failed", captcha },
        { status: 401 },
      );
    } catch (err) {
      return NextResponse.json(
        {
          error: result.error ?? "Kelme login failed",
          captchaError: err instanceof Error ? err.message : String(err),
        },
        { status: 401 },
      );
    }
  }

  await seedKelmeToken(result.token, result.refreshToken ?? null);
  return NextResponse.json({ ok: true });
}
