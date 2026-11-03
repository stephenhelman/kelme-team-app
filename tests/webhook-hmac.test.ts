import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";
import { verifyShopifyWebhookHmac } from "../lib/shopify-webhook";

const secret = "shpss_test_secret";
const body = JSON.stringify({ id: 6251234567890, name: "#1028" });
const sign = (b: string, s = secret) => createHmac("sha256", s).update(b, "utf8").digest("base64");

test("accepts a correctly signed body", () => {
  assert.equal(verifyShopifyWebhookHmac(body, sign(body), secret), true);
});

test("rejects a tampered body", () => {
  assert.equal(verifyShopifyWebhookHmac(body.replace("1028", "1029"), sign(body), secret), false);
});

test("rejects a signature made with the wrong secret", () => {
  assert.equal(verifyShopifyWebhookHmac(body, sign(body, "other"), secret), false);
});

test("rejects missing / empty header and empty secret", () => {
  assert.equal(verifyShopifyWebhookHmac(body, null, secret), false);
  assert.equal(verifyShopifyWebhookHmac(body, "", secret), false);
  assert.equal(verifyShopifyWebhookHmac(body, sign(body), ""), false);
});

test("rejects wrong-length and non-base64 signatures without throwing", () => {
  assert.equal(verifyShopifyWebhookHmac(body, "abc", secret), false);
  assert.equal(verifyShopifyWebhookHmac(body, "!!!not base64!!!", secret), false);
});

test("hashes exact bytes — re-serialized JSON with different whitespace fails", () => {
  const pretty = JSON.stringify(JSON.parse(body), null, 2);
  assert.equal(verifyShopifyWebhookHmac(pretty, sign(body), secret), false);
});
