/**
 * One-shot vendor email when the Kelme session dies — see
 * lib/kelme-token.ts's markKelmeTokenDead, the only caller. Sent via
 * Resend's HTTP API directly (no SDK — same hand-rolled-fetch style as
 * lib/kelme.ts / lib/shopify.ts).
 */
const RESEND_API_URL = "https://api.resend.com/emails";

export async function sendKelmeReauthNotification(): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.KELME_VENDOR_EMAIL;
  const from = process.env.RESEND_FROM ?? "Kelme Team <noreply@kelmeteam.com>";
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  if (!to) throw new Error("KELME_VENDOR_EMAIL is not set");

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject: "Kelme inventory sync needs re-authentication",
      text:
        "The Kelme inventory sync has stopped because the Kelme session expired.\n\n" +
        "Click here and solve the captcha to restore inventory sync: https://app.kelmeteam.com/reauth\n\n" +
        "Inventory will not update on Shopify until this is done.",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend send failed: HTTP ${res.status} ${body}`);
  }
}
