/**
 * "X new products are ready for you to price" — the vendor email for a run of
 * new Shopify drafts. Pure rendering (no env, no network; unit-tested) plus a
 * thin sender. Plain English and phone-friendly: one narrow column, each draft
 * is its own small table, large tap-target link to the draft in Shopify admin.
 */
import { createHash } from "crypto";
import { sendEmail } from "./email";
import type { DraftTodo } from "./draft-rules";

export interface DraftEmailItem {
  title: string;
  styleCode: string;
  shopifyProductId: string; // gid
  colors: string[]; // color names
  sizes: string[]; // sizes created
  sizesNotOffered: string[]; // policy-excluded sizes Kelme has but we do not carry
  todos: DraftTodo[];
}

export interface RenderedDraftEmail {
  subject: string;
  html: string;
  text: string;
}

const BADGE: Record<DraftTodo, { label: string; bg: string; fg: string }> = {
  "needs-price": { label: "Needs price", bg: "#fef3c7", fg: "#92400e" },
  "needs-images": { label: "Needs images", bg: "#fee2e2", fg: "#991b1b" },
  "needs-category": { label: "Needs category", bg: "#e0e7ff", fg: "#3730a3" },
  "needs-review": { label: "Check audience", bg: "#fce7f3", fg: "#9d174d" },
};

export function badgeLabel(t: DraftTodo): string {
  return BADGE[t].label;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function draftAdminUrl(adminBaseUrl: string, gid: string): string {
  return `${adminBaseUrl.replace(/\/$/, "")}/products/${gid.split("/").pop()}`;
}

export function draftEmailSubject(n: number): string {
  return n === 1 ? "1 new product is ready for you to price" : `${n} new products are ready for you to price`;
}

export function renderNewDraftsEmail(items: DraftEmailItem[], adminBaseUrl: string): RenderedDraftEmail {
  const n = items.length;
  const subject = draftEmailSubject(n);
  const steps = [
    "Set the price. Each draft has a placeholder price taken from Kelme's catalog — replace it with your real price.",
    "Add a description. A basic one was written from Kelme's data; edit it as you like.",
    "Add or check the images. Drafts marked “Needs images” have none yet (Kelme didn't supply one).",
    "Publish. When you're happy, change the status from Draft to Active and remove the “needs-…” tags.",
  ];

  const cards = items
    .map((p) => {
      const url = draftAdminUrl(adminBaseUrl, p.shopifyProductId);
      const badges = p.todos
        .map((t) => `<span style="display:inline-block;margin:0 6px 6px 0;padding:3px 9px;border-radius:12px;font-size:12px;font-weight:bold;background:${BADGE[t].bg};color:${BADGE[t].fg}">${esc(BADGE[t].label)}</span>`)
        .join("");
      const row = (k: string, v: string) =>
        `<tr><td style="padding:6px 10px;color:#666;font-size:13px;width:34%;vertical-align:top">${k}</td><td style="padding:6px 10px;font-size:14px;vertical-align:top">${v}</td></tr>`;
      return (
        `<table role="presentation" style="border-collapse:collapse;width:100%;margin:0 0 18px;border:1px solid #e5e5e5;border-radius:8px">` +
        `<tr><td colspan="2" style="padding:12px 10px;background:#f7f7f7;font-size:15px;font-weight:bold">${esc(p.title)}</td></tr>` +
        row("Style code", esc(p.styleCode)) +
        row("Colors", esc(p.colors.join(", ") || "—")) +
        row("Sizes", esc(p.sizes.join(", ") || "—")) +
        row("Sizes not offered", p.sizesNotOffered.length ? esc(p.sizesNotOffered.join(", ")) : "—") +
        row("To do", badges) +
        `<tr><td colspan="2" style="padding:10px"><a href="${esc(url)}" style="display:inline-block;padding:11px 18px;background:#111;color:#fff;text-decoration:none;border-radius:6px;font-size:14px">Open this draft in Shopify</a></td></tr>` +
        `</table>`
      );
    })
    .join("");

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;color:#111;max-width:600px;margin:0 auto;padding:0 12px">` +
    `<h2 style="margin:16px 0 8px;font-size:20px">${esc(subject)}</h2>` +
    `<p style="font-size:14px;line-height:1.5;margin:0 0 12px">${n === 1 ? "A new product was" : `${n} new products were`} added to your Shopify store as ${n === 1 ? "a draft" : "drafts"} from your Kelme favorites. Nothing is visible to customers until you publish it.</p>` +
    `<p style="font-size:14px;font-weight:bold;margin:0 0 6px">What you need to do for each one:</p>` +
    `<ol style="font-size:14px;line-height:1.5;margin:0 0 18px;padding-left:20px">${steps.map((s) => `<li style="margin-bottom:4px">${esc(s)}</li>`).join("")}</ol>` +
    cards +
    `<p style="color:#666;font-size:12px;margin:8px 0 24px">Stock is Kelme's quantity when the draft was created; the regular inventory sync keeps it current. “Sizes not offered” are sizes Kelme makes that we don't carry.</p>` +
    `</div>`;

  const text =
    `${subject}\n\n` +
    `${n === 1 ? "A new product was" : `${n} new products were`} added to your Shopify store as ${n === 1 ? "a draft" : "drafts"} from your Kelme favorites. Nothing is visible to customers until you publish it.\n\n` +
    `What you need to do for each one:\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` +
    items
      .map(
        (p) =>
          `${p.title}\n  Style code: ${p.styleCode}\n  Colors: ${p.colors.join(", ") || "-"}\n  Sizes: ${p.sizes.join(", ") || "-"}\n` +
          `  Sizes not offered: ${p.sizesNotOffered.join(", ") || "-"}\n  To do: ${p.todos.map(badgeLabel).join(", ")}\n  ${draftAdminUrl(adminBaseUrl, p.shopifyProductId)}`,
      )
      .join("\n\n");

  return { subject, html, text };
}

export async function sendNewDraftsEmail(
  items: DraftEmailItem[],
  opts: { adminBaseUrl: string; runId: number; to?: string },
): Promise<{ id?: string; to: string; cc?: string }> {
  if (items.length === 0) throw new Error("sendNewDraftsEmail called with no drafts");
  const to = opts.to ?? process.env.KELME_VENDOR_EMAIL;
  if (!to) throw new Error("KELME_VENDOR_EMAIL is not set");
  const cc = process.env.ADMIN_NOTIFY_EMAIL || undefined;
  const mail = renderNewDraftsEmail(items, opts.adminBaseUrl);
  const key = createHash("sha256").update(`run-${opts.runId}|${items.map((i) => i.shopifyProductId).sort().join("|")}`).digest("hex").slice(0, 32);
  const res = await sendEmail({ to, cc, ...mail, idempotencyKey: `new-drafts-${key}` });
  return { id: res.id, to, cc };
}
