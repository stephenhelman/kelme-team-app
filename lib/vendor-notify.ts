/**
 * One-shot vendor email when the Kelme session dies — see
 * lib/kelme-token.ts's markKelmeTokenDead, the only caller. Sent via
 * Resend's HTTP API directly (no SDK — same hand-rolled-fetch style as
 * lib/kelme.ts / lib/shopify.ts).
 */
import { resendApiKey, sendEmail } from "./email";

export async function sendKelmeReauthNotification(): Promise<void> {
  resendApiKey();
  const to = process.env.KELME_VENDOR_EMAIL;
  if (!to) throw new Error("KELME_VENDOR_EMAIL is not set");

  await sendEmail({
    to,
    subject: "Kelme inventory sync needs re-authentication",
    text:
      "The Kelme inventory sync has stopped because the Kelme session expired.\n\n" +
      "Click here and solve the captcha to restore inventory sync: https://app.kelmeteam.com/reauth\n\n" +
      "Inventory will not update on Shopify until this is done.",
  });
}
