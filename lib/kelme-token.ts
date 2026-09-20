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
import { sendKelmeReauthNotification } from "./vendor-notify";

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

export type KelmeTokenSource = "captcha_reauth" | "manual_seed";

// Closes whatever KelmeTokenHistory row is still open (diedAt: null), if
// any — there's at most one at a time. Used both on real death detection
// and when a new token is minted while the old one was never marked dead
// (e.g. a proactive re-auth).
async function closeOpenHistoryRow(deathReason: string, when: Date): Promise<void> {
  await prisma.kelmeTokenHistory.updateMany({
    where: { diedAt: null },
    data: { diedAt: when, deathReason },
  });
}

/** Bootstrap or replace the token wholesale — used by the one-time seed script and, later, the re-auth flow. */
export async function seedKelmeToken(
  accessToken: string,
  refreshToken?: string | null,
  source: KelmeTokenSource = "captcha_reauth",
): Promise<void> {
  const now = new Date();
  await prisma.kelmeToken.upsert({
    where: { id: 1 },
    update: {
      accessToken: encrypt(accessToken),
      refreshToken: refreshToken ? encrypt(refreshToken) : null,
      status: "alive",
      obtainedAt: now,
      lastRefreshedAt: now,
      deadNotifiedAt: null,
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

  await closeOpenHistoryRow("manual", now);
  await prisma.kelmeTokenHistory.create({
    data: { mintedAt: now, source },
  });
}

/** Called when a live Kelme response rolls the token forward — keeps the DB current without disturbing obtainedAt/status. */
export async function saveRefreshedKelmeToken(freshAccessToken: string): Promise<void> {
  const now = new Date();
  await prisma.kelmeToken.update({
    where: { id: 1 },
    data: {
      accessToken: encrypt(freshAccessToken),
      lastRefreshedAt: now,
    },
  });

  await prisma.kelmeTokenHistory.updateMany({
    where: { diedAt: null },
    data: { refreshCount: { increment: 1 }, lastRefreshedAt: now },
  });
}

/**
 * Called on a dead-session response (code:000005, code:1009, or any other
 * code/message caught by lib/kelme.ts's deadSessionCode check) — halts
 * syncing until a fresh captcha login flips status back to "alive"
 * (seedKelmeToken, which also clears deadNotifiedAt).
 *
 * Sends exactly one vendor email per death event: deadNotifiedAt starts
 * null and is only ever set here, atomically (the updateMany's `deadNotifiedAt:
 * null` guard means only the first caller to observe it null wins the
 * send), so a token that's already dead — every subsequent sync cycle
 * until re-auth — never re-sends.
 */
export async function markKelmeTokenDead(deathReason: string): Promise<void> {
  const now = new Date();
  await prisma.kelmeToken.update({
    where: { id: 1 },
    data: { status: "dead" },
  });

  await closeOpenHistoryRow(deathReason, now);

  const claimed = await prisma.kelmeToken.updateMany({
    where: { id: 1, deadNotifiedAt: null },
    data: { deadNotifiedAt: now },
  });
  if (claimed.count === 0) return;

  try {
    await sendKelmeReauthNotification();
  } catch (err) {
    console.error(`[kelme-token] dead-notification email failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
