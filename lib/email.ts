/**
 * Shared Resend sender — the raw-fetch pattern (no SDK) that
 * lib/admin-notify.ts and lib/vendor-notify.ts used to each hand-roll.
 * Callers resolve their own recipient; this owns the API key, the from
 * address, the request shape, and error formatting.
 */
const RESEND_API_URL = "https://api.resend.com/emails";

export interface EmailAttachment {
  filename: string;
  /** Raw file content — a string is treated as UTF-8 text; encoded to base64 for Resend. */
  content: string | Buffer;
  contentType?: string;
}

export interface SendEmailInput {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: EmailAttachment[];
  /** Sent as Resend's Idempotency-Key header — a retried send with the same key is not delivered twice. */
  idempotencyKey?: string;
}

export interface SendEmailResult {
  /** Resend's id for the sent message, when the response carried one. */
  id?: string;
}

/** Throws the same error the callers used to when the key is missing. */
export function resendApiKey(): string {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set");
  return apiKey;
}

export async function sendEmail({
  to,
  cc,
  subject,
  html,
  text,
  attachments,
  idempotencyKey,
}: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = resendApiKey();
  const from = process.env.RESEND_FROM ?? "Kelme Team <noreply@kelmeteam.com>";

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      from,
      to,
      cc,
      subject,
      html,
      text,
      attachments: attachments?.map((a) => ({
        filename: a.filename,
        content: (typeof a.content === "string" ? Buffer.from(a.content, "utf8") : a.content).toString("base64"),
        ...(a.contentType ? { content_type: a.contentType } : {}),
      })),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend send failed: HTTP ${res.status} ${body}`);
  }

  const json = (await res.json().catch(() => null)) as { id?: string } | null;
  return { id: json?.id };
}
