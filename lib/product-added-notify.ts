/**
 * "Products added" email to the vendor/client. Pure rendering
 * (renderProductsAddedEmail — unit-tested, no env, no network) plus a thin
 * sender. Fed by whatever adds products: today the draft pipeline
 * (scripts/drafts.ts); a future auto-adding sync can call
 * notifyProductsAdded with the same AddedProduct shape.
 */
import { createHash } from "crypto";
import { sendEmail } from "./email";

export interface AddedProduct {
  title: string;
  styleCode: string;
  shopifyProductId: string; // gid
  status: string; // DRAFT
  category: string | null;
  variantCount: number;
  colorCount: number;
  sizes: string[];
  imagesAttached: number;
  totalQty: number; // Kelme units in stock across all variants at creation
  variantsInStock: number;
  price: string; // placeholder
  needsPricing: boolean;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function adminUrl(adminBaseUrl: string, gid: string): string {
  return `${adminBaseUrl.replace(/\/$/, "")}/products/${gid.split("/").pop()}`;
}

export function renderProductsAddedEmail(products: AddedProduct[], adminBaseUrl: string): RenderedEmail {
  const n = products.length;
  const variants = products.reduce((s, p) => s + p.variantCount, 0);
  const pricing = products.filter((p) => p.needsPricing).length;
  const noun = n === 1 ? "product" : "products";
  const subject = `${n} new Kelme ${noun} added to your store${pricing > 0 ? " — drafts awaiting pricing" : ""}`;

  const intro =
    `${n} ${noun} (${variants} variants in total) ${n === 1 ? "was" : "were"} added to your Shopify store as ` +
    `${n === 1 ? "a draft" : "drafts"} from your Kelme favorites. ` +
    `Nothing is visible to customers yet.`;
  const next =
    pricing > 0
      ? `${pricing} ${pricing === 1 ? "has" : "have"} a placeholder price (taken from Kelme's catalog price) and the "needs-pricing" tag. ` +
        `Set the real prices, remove that tag, then change the status to Active to publish.`
      : `Review each draft, then change its status to Active to publish.`;

  const rows = products
    .map((p) => {
      const url = adminUrl(adminBaseUrl, p.shopifyProductId);
      return (
        `<tr>` +
        `<td style="padding:8px;border-bottom:1px solid #e5e5e5"><a href="${esc(url)}">${esc(p.title)}</a><br><span style="color:#666">${esc(p.styleCode)}${p.category ? ` · ${esc(p.category.split(" > ").slice(-1)[0])}` : ""}</span></td>` +
        `<td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right">${p.variantCount}<br><span style="color:#666">${p.colorCount} colors × ${esc(p.sizes.join(", "))}</span></td>` +
        `<td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right">${p.totalQty}<br><span style="color:#666">${p.variantsInStock}/${p.variantCount} variants in stock</span></td>` +
        `<td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right">$${esc(p.price)}${p.needsPricing ? `<br><span style="color:#b45309">needs pricing</span>` : ""}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right">${p.imagesAttached}</td>` +
        `</tr>`
      );
    })
    .join("");

  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;max-width:760px">` +
    `<h2 style="margin:0 0 12px">New Kelme products added</h2>` +
    `<p>${esc(intro)}</p><p>${esc(next)}</p>` +
    `<table style="border-collapse:collapse;width:100%"><thead><tr style="text-align:left;background:#f5f5f5">` +
    `<th style="padding:8px">Product</th><th style="padding:8px;text-align:right">Variants</th>` +
    `<th style="padding:8px;text-align:right">Kelme stock</th><th style="padding:8px;text-align:right">Price</th>` +
    `<th style="padding:8px;text-align:right">Images</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p style="color:#666;margin-top:16px">Stock shown is Kelme's quantity at the time the product was created; ` +
    `the regular inventory sync keeps it current from here.</p></div>`;

  const text =
    `${intro}\n${next}\n\n` +
    products
      .map(
        (p) =>
          `- ${p.title} (${p.styleCode})\n  ${p.variantCount} variants (${p.colorCount} colors x ${p.sizes.join(", ")}), ` +
          `${p.totalQty} units in Kelme stock, ${p.imagesAttached} images, $${p.price}${p.needsPricing ? " [needs pricing]" : ""}\n  ${adminUrl(adminBaseUrl, p.shopifyProductId)}`,
      )
      .join("\n") +
    `\n\nStock is Kelme's quantity at creation; the regular inventory sync keeps it current.`;

  return { subject, html, text };
}

export async function notifyProductsAdded(
  products: AddedProduct[],
  opts: { adminBaseUrl: string; to?: string; cc?: string | null },
): Promise<{ id?: string; to: string }> {
  if (products.length === 0) throw new Error("notifyProductsAdded called with no products");
  const to = opts.to ?? process.env.KELME_VENDOR_EMAIL;
  if (!to) throw new Error("KELME_VENDOR_EMAIL is not set");
  const mail = renderProductsAddedEmail(products, opts.adminBaseUrl);
  // Same product set => same key, so a retried send is not delivered twice.
  const key = createHash("sha256").update(products.map((p) => p.shopifyProductId).sort().join("|")).digest("hex").slice(0, 32);
  const res = await sendEmail({
    to,
    // cc: null = none; undefined = the admin address, if configured.
    cc: opts.cc === null ? undefined : (opts.cc ?? (process.env.ADMIN_NOTIFY_EMAIL || undefined)),
    ...mail,
    idempotencyKey: `products-added-${key}`,
  });
  return { id: res.id, to };
}
