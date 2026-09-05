/**
 * Encrypted Kelme B2B session token storage (singleton row, id 1) — the
 * shared source of truth for both the Next app and the Railway worker.
 * Same AES-256-GCM approach as lib/shopify.ts's ShopifyToken store, keyed
 * off the same SHOPIFY_TOKEN_ENCRYPTION_KEY (a distinct scrypt salt keeps
 * the derived key separate from the Shopify one).
 *
 * No "previous token" is ever kept — a superseded token is dead credentials
 * with no use. "Time alive" is derived from obtainedAt, not stored.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { prisma } from "./prisma";

function encryptionKey(): Buffer {
  const secret = process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error("SHOPIFY_TOKEN_ENCRYPTION_KEY is not set");
  return scryptSync(secret, "kelme-token", 32);
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("hex")).join(".");
}

function decrypt(encoded: string): string {
  const [ivHex, authTagHex, ciphertextHex] = encoded.split(".");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextHex, "hex")), decipher.final()]).toString("utf8");
}

export type KelmeTokenStatus = "alive" | "dead" | "needs_reauth";

export interface StoredKelmeToken {
  accessToken: string;
  refreshToken: string | null;
  status: KelmeTokenStatus;
  obtainedAt: Date;
  lastRefreshedAt: Date;
}

export async function getStoredKelmeToken(): Promise<StoredKelmeToken | null> {
  const row = await prisma.kelmeToken.findUnique({ where: { id: 1 } });
  if (!row) return null;
  return {
    accessToken: decrypt(row.accessToken),
    refreshToken: row.refreshToken ? decrypt(row.refreshToken) : null,
    status: row.status as KelmeTokenStatus,
    obtainedAt: row.obtainedAt,
    lastRefreshedAt: row.lastRefreshedAt,
  };
}

/** Bootstrap or replace the token wholesale — used by the one-time seed script and, later, the re-auth flow. */
export async function seedKelmeToken(accessToken: string, refreshToken?: string | null): Promise<void> {
  const now = new Date();
  await prisma.kelmeToken.upsert({
    where: { id: 1 },
    update: {
      accessToken: encrypt(accessToken),
      refreshToken: refreshToken ? encrypt(refreshToken) : null,
      status: "alive",
      obtainedAt: now,
      lastRefreshedAt: now,
    },
    create: {
      id: 1,
      accessToken: encrypt(accessToken),
      refreshToken: refreshToken ? encrypt(refreshToken) : null,
      status: "alive",
      obtainedAt: now,
      lastRefreshedAt: now,
    },
  });
}

/** Called when a live Kelme response rolls the token forward — keeps the DB current without disturbing obtainedAt/status. */
export async function saveRefreshedKelmeToken(freshAccessToken: string): Promise<void> {
  await prisma.kelmeToken.update({
    where: { id: 1 },
    data: {
      accessToken: encrypt(freshAccessToken),
      lastRefreshedAt: new Date(),
    },
  });
}

/** Called on a code:000005 (dead session) response — halts syncing until a fresh captcha login flips status back to "alive". */
export async function markKelmeTokenDead(): Promise<void> {
  await prisma.kelmeToken.update({
    where: { id: 1 },
    data: { status: "dead" },
  });
}
