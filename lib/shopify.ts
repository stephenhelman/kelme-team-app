/**
 * Server-side Shopify Admin API client for the single-store custom app.
 * Only call these from route handlers — never from a "use client" component.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "crypto";
import { prisma } from "./prisma";

export const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION ?? "2026-07";
export const SHOPIFY_SCOPES =
  "read_products,write_products,read_inventory,write_inventory,read_locations";

function shopDomain(): string {
  const shop = process.env.SHOPIFY_SHOP;
  if (!shop) throw new Error("SHOPIFY_SHOP is not set");
  return shop.includes(".") ? shop : `${shop}.myshopify.com`;
}

export function shopifyAuthorizeUrl(
  redirectUri: string,
  state: string,
): string {
  const clientId = process.env.SHOPIFY_API_KEY;
  if (!clientId) throw new Error("SHOPIFY_API_KEY is not set");

  const url = new URL(`https://${shopDomain()}/admin/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", SHOPIFY_SCOPES);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCodeForToken(
  code: string,
): Promise<{ access_token: string; scope: string }> {
  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("SHOPIFY_API_KEY / SHOPIFY_API_SECRET are not set");

  const res = await fetch(`https://${shopDomain()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Shopify token exchange failed: HTTP ${res.status} ${body}`,
    );
  }

  return res.json();
}

export async function shopifyAdminFetch(pathOrUrl: string): Promise<Response> {
  const token = await getStoredAccessToken();
  if (!token)
    throw new Error("No Shopify access token stored — run /shopify/auth first");

  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `https://${shopDomain()}/admin/api/${SHOPIFY_API_VERSION}${pathOrUrl}`;

  return fetch(url, {
    headers: { "X-Shopify-Access-Token": token },
    cache: "no-store",
  });
}

/** Parses the `next` page URL out of a Shopify Link response header, if present. */
export function parseNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const [, urlPart, relPart] = part.match(/<([^>]+)>;\s*rel="([^"]+)"/) ?? [];
    if (relPart === "next") return urlPart ?? null;
  }
  return null;
}

// --- Encrypted token storage (singleton row, id 1) ---

function encryptionKey(): Buffer {
  const secret = process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error("SHOPIFY_TOKEN_ENCRYPTION_KEY is not set");
  return scryptSync(secret, "shopify-token", 32);
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("hex")).join(".");
}

function decrypt(encoded: string): string {
  const [ivHex, authTagHex, ciphertextHex] = encoded.split(".");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

export async function saveAccessToken(
  accessToken: string,
  scope: string,
): Promise<void> {
  const encryptedToken = encrypt(accessToken);
  await prisma.shopifyToken.upsert({
    where: { id: 1 },
    update: { encryptedToken, scope },
    create: { id: 1, encryptedToken, scope },
  });
}

export async function getStoredAccessToken(): Promise<string | null> {
  const row = await prisma.shopifyToken.findUnique({ where: { id: 1 } });
  if (!row) return null;
  return decrypt(row.encryptedToken);
}
