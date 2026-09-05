/**
 * Server-side Kelme captcha login flow — the pubkey -> RSA-encrypt-password
 * -> captcha -> login sequence proven out in kelme-token-test/index.js.
 * Never call from a "use client" component; the password only ever leaves
 * this process RSA-encrypted, and the plaintext creds come from env.
 */
import { constants, publicEncrypt } from "crypto";

const ORIGIN = process.env.KELME_ORIGIN ?? "http://gkemb2b.kelmechina.com:5020";

function headers(extra?: Record<string, string>): Record<string, string> {
  return { Schema: "main", ...extra };
}

async function fetchPubKeyPem(): Promise<string> {
  const res = await fetch(`${ORIGIN}/svr/portal/user/pubkey`, {
    headers: headers(),
    cache: "no-store",
  });
  const data = await res.json().catch(() => null);
  const b64 = data?.body?.pubKey;
  if (typeof b64 !== "string" || !b64) {
    throw new Error(`Kelme pubkey response missing body.pubKey: ${JSON.stringify(data)}`);
  }
  const wrapped = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

export interface KelmeCaptcha {
  imageUrl: string; // data: URL, ready to drop into an <img src>
  sign: string; // single-use, time-limited — must be replayed with the answer
  pem: string; // this attempt's RSA public key, paired with `sign`
}

/** Fetches a fresh pubkey + captcha pair. Each captcha is single-use and expires — call again on every retry. */
export async function fetchKelmeCaptcha(): Promise<KelmeCaptcha> {
  const pem = await fetchPubKeyPem();
  const res = await fetch(`${ORIGIN}/svr/portal/user/captcha/image`, {
    headers: headers(),
    cache: "no-store",
  });
  const data = await res.json().catch(() => null);
  const body = data?.body ?? {};
  if (!body.url || !body.sign) {
    throw new Error(`Kelme captcha response missing body.url/body.sign: ${JSON.stringify(data)}`);
  }
  return { imageUrl: body.url, sign: body.sign, pem };
}

function encryptPassword(pem: string, password: string): string {
  const encrypted = publicEncrypt(
    { key: pem, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(password, "utf8"),
  );
  return encrypted.toString("base64");
}

export interface KelmeLoginResult {
  ok: boolean;
  token?: string;
  refreshToken?: string | null;
  error?: string;
}

/** Completes login with a solved captcha, using KELME_USERNAME/KELME_PASSWORD from env. */
export async function attemptKelmeLogin(
  pem: string,
  sign: string,
  captchaCode: string,
): Promise<KelmeLoginResult> {
  const username = process.env.KELME_USERNAME;
  const password = process.env.KELME_PASSWORD;
  if (!username || !password) {
    return { ok: false, error: "KELME_USERNAME / KELME_PASSWORD are not set" };
  }

  const body = {
    username,
    pwd: encryptPassword(pem, password),
    language: "en_US",
    captcha: captchaCode,
    sign,
    type: "password",
    value: username,
  };

  const res = await fetch(`${ORIGIN}/svr/portal/user/login`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json;charset=UTF-8" }),
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const data = await res.json().catch(() => null);
  const unwrapped = data && typeof data.body === "object" && data.body !== null ? data.body : data;

  if (res.ok && unwrapped && typeof unwrapped.token === "string" && unwrapped.token.length > 0) {
    return {
      ok: true,
      token: unwrapped.token,
      refreshToken: typeof unwrapped.refresh_token === "string" ? unwrapped.refresh_token : null,
    };
  }

  const message =
    unwrapped?.message ?? unwrapped?.msg ?? data?.message ?? `Kelme login failed (HTTP ${res.status})`;
  return { ok: false, error: String(message) };
}
