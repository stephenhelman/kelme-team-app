/**
 * Shopify webhook request verification.
 *
 * Webhooks registered through the Admin API (webhookSubscriptionCreate, which
 * is how this app registers them — scripts/register-orders-webhook.ts) are
 * signed with the app's client secret, i.e. SHOPIFY_API_SECRET. (A webhook
 * created by hand in Settings > Notifications is instead signed with a
 * separate per-store secret shown on that page — not used here.)
 */
import { createHmac, timingSafeEqual } from "crypto";

/**
 * `rawBody` must be the exact bytes Shopify sent (req.text() BEFORE any
 * JSON.parse) — re-serialized JSON will not hash the same. `header` is the
 * X-Shopify-Hmac-Sha256 value (base64 of the HMAC-SHA256 digest).
 */
export function verifyShopifyWebhookHmac(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
): boolean {
  if (!header || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const actual = Buffer.from(header, "base64");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(expected, actual);
}
