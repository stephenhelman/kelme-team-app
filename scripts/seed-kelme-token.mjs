/**
 * One-time bootstrap: inserts a currently-valid Kelme session token into the
 * KelmeToken table (status="alive", obtainedAt/lastRefreshedAt=now). After
 * this, lib/kelme.ts reads/refreshes the token from the DB — this script is
 * only needed the first time, or after a manual re-auth outside the (later)
 * automated captcha-login flow.
 *
 * Usage:
 *   node --env-file=.env scripts/seed-kelme-token.mjs "<token>" ["<refreshToken>"]
 *
 * Requires SHOPIFY_TOKEN_ENCRYPTION_KEY and DATABASE_URL in .env.
 */
import { createCipheriv, randomBytes, scryptSync } from "crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function encryptionKey() {
  const secret = process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error("SHOPIFY_TOKEN_ENCRYPTION_KEY is not set");
  return scryptSync(secret, "kelme-token", 32);
}

function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("hex")).join(".");
}

const [accessToken, refreshToken] = process.argv.slice(2);

if (!accessToken) {
  console.error('Usage: node --env-file=.env scripts/seed-kelme-token.mjs "<token>" ["<refreshToken>"]');
  process.exit(1);
}

async function main() {
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

  // Mirror lib/kelme-token.ts's seedKelmeToken bookkeeping: close whatever
  // history row is still open (there's a prior token this is superseding),
  // then open a fresh one for this manually-seeded token.
  await prisma.kelmeTokenHistory.updateMany({
    where: { diedAt: null },
    data: { diedAt: now, deathReason: "manual" },
  });
  await prisma.kelmeTokenHistory.create({
    data: { mintedAt: now, source: "manual_seed" },
  });

  console.log("Kelme token seeded — status=alive, obtainedAt=" + now.toISOString());
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
