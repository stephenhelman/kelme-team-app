/**
 * Builds the order sheet sent to the vendor: subject, HTML work order, plain
 * text fallback, and the per-unit CSV attachment. Pure — takes the order, its
 * audit, and resolved variant info; no I/O. The HTML is the primary
 * deliverable (read by a non-technical vendor, often on a phone), so it is
 * single-column, table-based, inline-styled, and image-optional.
 */
import { FEE_KINDS } from "./order-config";
import { CANONICAL_SIZE_ORDER } from "./sizes";
import type { AuditResult, CustomizedLine, RosterEntry } from "./order-audit";
import type { OrderLineItem, OrderPayload } from "./order-types";

export interface VariantInfo {
  styleCode: string;
  colorName: string;
  size: string;
}
/** Keyed by SKU. */
export type VariantInfoBySku = Map<string, VariantInfo>;

interface ResolvedLine {
  line: OrderLineItem;
  title: string;
  styleCode: string;
  color: string;
  size: string;
}

// --- shared ------------------------------------------------------------------

function sizeRank(size: string): number {
  const i = CANONICAL_SIZE_ORDER.indexOf(size);
  return i === -1 ? CANONICAL_SIZE_ORDER.length + 1 : i;
}

const SIZE_TOKEN = /^(\d{1,3}(cm)?|[2-5]?x{0,2}[sml]|[2-5]?xl|2xs|xs|one size|os)$/i;

/** Variant info from the DB when the SKU matches; otherwise best-effort from the variant title ("Black / M"). */
function resolveLine(line: OrderLineItem, info: VariantInfoBySku): ResolvedLine {
  const v = line.sku ? info.get(line.sku) : undefined;
  let color = v?.colorName ?? "";
  let size = v?.size ?? "";
  if (!color || !size) {
    const parts = (line.variant_title ?? "").split("/").map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      if (!size && SIZE_TOKEN.test(p)) size = p;
      else if (!color) color = p;
    }
  }
  return {
    line,
    title: line.title,
    styleCode: v?.styleCode ?? (line.sku ? line.sku.split("-")[0] : ""),
    color,
    size,
  };
}

function compareResolved(a: ResolvedLine, b: ResolvedLine): number {
  return (
    a.title.localeCompare(b.title) ||
    a.color.localeCompare(b.color) ||
    sizeRank(a.size) - sizeRank(b.size) ||
    a.size.localeCompare(b.size)
  );
}

/** Roster entries sorted by size then jersey number; numberless entries last. */
function sortedRoster(roster: RosterEntry[], fallbackSize: string): (RosterEntry & { size: string })[] {
  return roster
    .map((e) => ({ ...e, size: e.size || fallbackSize }))
    .sort((a, b) => {
      const an = a.number === "" ? Infinity : Number(a.number);
      const bn = b.number === "" ? Infinity : Number(b.number);
      return sizeRank(a.size) - sizeRank(b.size) || (Number.isNaN(an) ? Infinity : an) - (Number.isNaN(bn) ? Infinity : bn) || (a.n ?? 0) - (b.n ?? 0);
    });
}

export function buildSubject(order: OrderPayload, audit: AuditResult): string {
  const n = audit.customized.length;
  const what = n === 0 ? "no customized lines" : `${n} customized line${n === 1 ? "" : "s"}`;
  return `${audit.flags.length > 0 ? "⚠ CHECK " : ""}Order ${order.name} — ${what}`;
}

// --- CSV ---------------------------------------------------------------------

export const CSV_HEADER = [
  "Order",
  "Product",
  "Style Code",
  "Color",
  "Size",
  "SKU",
  "Number",
  "Name",
  "Logo Application",
  "Logo Placement",
  "Number Placement",
  "Print Color",
  "Logo URL",
] as const;

/** Quote a cell; neutralise spreadsheet formula injection (=, +, -, @) from customer-typed text. */
function csvCell(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** One row per unit across all non-fee lines. Fee lines are not goods and are excluded. */
export function buildCsv(order: OrderPayload, audit: AuditResult, info: VariantInfoBySku): string {
  const rows: string[][] = [];
  const customizedByLine = new Map<number, CustomizedLine>(audit.customized.map((c) => [c.line.id, c]));
  const goods = [...audit.coreLines, ...audit.otherLines].map((l) => resolveLine(l, info)).sort(compareResolved);

  for (const r of goods) {
    const c = customizedByLine.get(r.line.id);
    const base = (size: string, number: string, name: string) => [
      order.name,
      r.title,
      r.styleCode,
      r.color,
      size,
      r.line.sku ?? "",
      number,
      name,
      c?.logoApplication ?? "",
      c?.logoPlacement ?? "",
      c?.numberPlacement ?? "",
      c?.printColor ?? "",
      c?.logoUrl ?? "",
    ];
    if (c && c.roster.length > 0) {
      for (const e of sortedRoster(c.roster, r.size)) rows.push(base(e.size, e.number, e.name));
      // Roster shorter than quantity: pad so the sheet still has one row per unit (the audit flags the gap).
      for (let i = c.roster.length; i < r.line.quantity; i++) rows.push(base(r.size, "", ""));
    } else {
      for (let i = 0; i < r.line.quantity; i++) rows.push(base(r.size, "", ""));
    }
  }

  return [CSV_HEADER as readonly string[], ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// --- HTML --------------------------------------------------------------------

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const money = (n: number) => `$${n.toFixed(2)}`;

const C = {
  ink: "#1a1a1a",
  muted: "#6b6b6b",
  line: "#e3e3e3",
  bg: "#f4f4f2",
  card: "#ffffff",
  warnBg: "#fff4e5",
  warnBorder: "#e8a33d",
  warnInk: "#7a4a00",
  okBg: "#eaf6ec",
  okInk: "#1f6b34",
  zebra: "#f8f8f6",
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function detailRow(label: string, value: string): string {
  if (!value) return "";
  return `<tr><td style="padding:3px 12px 3px 0;color:${C.muted};font-size:14px;white-space:nowrap;vertical-align:top;">${esc(label)}</td><td style="padding:3px 0;font-size:14px;color:${C.ink};font-weight:600;">${esc(value)}</td></tr>`;
}

function lineBlock(r: ResolvedLine, c: CustomizedLine): string {
  const heading = [r.color, r.size && `Size ${r.size}`].filter(Boolean).join(" · ");

  const logo = !c.logoUrl
    ? ""
    : c.logoUrlSafe
      ? `<tr><td style="padding:12px 16px 0 16px;">
          <a href="${esc(c.logoUrl)}" style="text-decoration:none;"><img src="${esc(c.logoUrl)}" alt="Customer logo" width="160" style="display:block;width:160px;max-width:60%;height:auto;border:1px solid ${C.line};border-radius:6px;background:#ffffff;"></a>
          <div style="padding-top:6px;font-size:13px;"><a href="${esc(c.logoUrl)}" style="color:#0b57d0;">Open full-size logo</a></div>
        </td></tr>`
      : `<tr><td style="padding:12px 16px 0 16px;font-size:13px;color:${C.warnInk};">Logo file (not a verified Shopify link — not clickable): ${esc(c.logoUrl)}</td></tr>`;

  const details = [
    detailRow("Application", c.logoApplication ?? ""),
    detailRow("Logo placement", c.logoPlacement),
    detailRow("Number placement", c.numberPlacement),
    detailRow("Print color", c.printColor),
    detailRow("Quantity", String(r.line.quantity)),
  ].join("");

  const roster = sortedRoster(c.roster, r.size);
  const hasNum = roster.some((e) => e.number);
  const hasName = roster.some((e) => e.name);
  const th = `padding:6px 8px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;color:${C.muted};border-bottom:2px solid ${C.line};`;
  const players =
    roster.length === 0
      ? `<tr><td style="padding:12px 16px;font-size:14px;color:${C.warnInk};">No player list on this line.</td></tr>`
      : `<tr><td style="padding:14px 16px 4px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
            <tr><th style="${th}width:36px;">#</th>${hasNum ? `<th style="${th}">Number</th>` : ""}${hasName ? `<th style="${th}">Name</th>` : ""}<th style="${th}width:56px;">Size</th></tr>
            ${roster
              .map((e, i) => {
                const td = `padding:7px 8px;font-size:15px;color:${C.ink};border-bottom:1px solid ${C.line};background:${i % 2 ? C.zebra : C.card};`;
                return `<tr><td style="${td}color:${C.muted};">${i + 1}</td>${hasNum ? `<td style="${td}font-weight:700;">${esc(e.number)}</td>` : ""}${hasName ? `<td style="${td}">${esc(e.name)}</td>` : ""}<td style="${td}">${esc(e.size)}</td></tr>`;
              })
              .join("")}
          </table></td></tr>`;

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;background:${C.card};border:1px solid ${C.line};border-radius:10px;border-collapse:separate;">
    <tr><td style="padding:16px 16px 0 16px;">
      <div style="font-size:18px;font-weight:700;color:${C.ink};line-height:1.25;">${esc(r.title)}</div>
      <div style="font-size:15px;color:${C.ink};padding-top:2px;">${esc(heading)}${r.styleCode ? `<span style="color:${C.muted};"> · Style ${esc(r.styleCode)}</span>` : ""}</div>
    </td></tr>
    ${logo}
    <tr><td style="padding:12px 16px 0 16px;"><table role="presentation" cellpadding="0" cellspacing="0">${details}</table></td></tr>
    ${players}
    <tr><td style="height:12px;line-height:12px;font-size:0;">&nbsp;</td></tr>
  </table>`;
}

function sectionTitle(text: string): string {
  return `<div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${C.muted};padding:8px 2px 8px 2px;">${esc(text)}</div>`;
}

export function buildHtml(order: OrderPayload, audit: AuditResult, info: VariantInfoBySku): string {
  const customized = new Map(audit.customized.map((c) => [c.line.id, c]));
  const blocks = audit.customized
    .map((c) => ({ r: resolveLine(c.line, info), c }))
    .sort((a, b) => compareResolved(a.r, b.r));
  const plain = audit.plainLines.map((l) => resolveLine(l, info)).sort(compareResolved);

  const flags =
    audit.flags.length > 0
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;background:${C.warnBg};border:1px solid ${C.warnBorder};border-left:6px solid ${C.warnBorder};border-radius:8px;border-collapse:separate;">
          <tr><td style="padding:14px 16px;">
            <div style="font-size:16px;font-weight:700;color:${C.warnInk};padding-bottom:6px;">⚠ Please check before producing (${audit.flags.length})</div>
            <ul style="margin:0;padding:0 0 0 20px;color:${C.warnInk};font-size:15px;line-height:1.45;">
              ${audit.flags.map((f) => `<li style="padding:2px 0;">${esc(f.message)}</li>`).join("")}
            </ul>
          </td></tr></table>`
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;background:${C.okBg};border-radius:8px;border-collapse:separate;"><tr><td style="padding:10px 16px;font-size:14px;color:${C.okInk};font-weight:600;">✓ All order checks passed</td></tr></table>`;

  const plainSection =
    plain.length === 0
      ? ""
      : `${sectionTitle("Items without customization")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;background:${C.card};border:1px solid ${C.line};border-radius:10px;border-collapse:separate;">
          ${plain
            .map(
              (r) => `<tr><td style="padding:10px 16px;border-bottom:1px solid ${C.line};font-size:15px;color:${C.ink};"><strong>${r.line.quantity} ×</strong> ${esc(r.title)}<div style="font-size:13px;color:${C.muted};">${esc([r.color, r.size && `Size ${r.size}`, r.line.sku].filter(Boolean).join(" · "))}</div></td></tr>`,
            )
            .join("")}
        </table>`;

  const feeSection =
    audit.fees.length === 0
      ? ""
      : `${sectionTitle("Customization charged on this order")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;background:${C.card};border:1px solid ${C.line};border-radius:10px;border-collapse:separate;">
          ${audit.fees
            .map((f) => {
              const cfg = FEE_KINDS[f.kind];
              return `<tr><td style="padding:8px 16px;font-size:14px;color:${C.ink};border-bottom:1px solid ${C.line};">${esc(cfg.label)}</td><td style="padding:8px 16px;font-size:14px;color:${C.ink};text-align:right;border-bottom:1px solid ${C.line};white-space:nowrap;">${f.actualUnits} ${esc(cfg.unit)}${f.actualUnits === 1 ? "" : "s"} · ${money(f.actualAmount)}</td></tr>`;
            })
            .join("")}
        </table>`;

  const itemsLine = `${audit.coreCount} item${audit.coreCount === 1 ? "" : "s"}`;
  const custLine = `${blocks.length} customized line${blocks.length === 1 ? "" : "s"}`;
  const created = order.created_at ? new Date(order.created_at).toISOString().slice(0, 10) : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Order ${esc(order.name)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};color:${C.ink};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:16px 10px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;">
    <tr><td style="padding:4px 2px 16px 2px;">
      <div style="font-size:26px;font-weight:800;line-height:1.2;">Order ${esc(order.name)}</div>
      <div style="font-size:15px;color:${C.muted};padding-top:4px;">${esc(itemsLine)} · ${esc(custLine)}${created ? ` · ${esc(created)}` : ""}</div>
    </td></tr>
    <tr><td>${flags}</td></tr>
    <tr><td>
      ${blocks.length > 0 ? sectionTitle("Customized items") : ""}
      ${blocks.map(({ r, c }) => lineBlock(r, customized.get(r.line.id) ?? c)).join("")}
      ${plainSection}
      ${feeSection}
      <div style="font-size:13px;color:${C.muted};padding:4px 2px 8px 2px;">A spreadsheet with one row per garment is attached (CSV).</div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

// --- plain text --------------------------------------------------------------

export function buildText(order: OrderPayload, audit: AuditResult, info: VariantInfoBySku): string {
  const out: string[] = [`ORDER ${order.name}`, `${audit.coreCount} items · ${audit.customized.length} customized line(s)`, ""];
  if (audit.flags.length > 0) {
    out.push("PLEASE CHECK BEFORE PRODUCING:");
    for (const f of audit.flags) out.push(`  ! ${f.message}`);
    out.push("");
  }
  const blocks = audit.customized.map((c) => ({ r: resolveLine(c.line, info), c })).sort((a, b) => compareResolved(a.r, b.r));
  for (const { r, c } of blocks) {
    out.push(`${r.title} — ${[r.color, r.size && `Size ${r.size}`].filter(Boolean).join(", ")} (qty ${r.line.quantity})`);
    if (c.logoApplication) out.push(`  Application: ${c.logoApplication}`);
    if (c.logoPlacement) out.push(`  Logo placement: ${c.logoPlacement}`);
    if (c.numberPlacement) out.push(`  Number placement: ${c.numberPlacement}`);
    if (c.printColor) out.push(`  Print color: ${c.printColor}`);
    if (c.logoUrl) out.push(`  Logo: ${c.logoUrl}`);
    sortedRoster(c.roster, r.size).forEach((e, i) => out.push(`  ${i + 1}. #${e.number || "-"}  ${e.name || "-"}  (${e.size})`));
    out.push("");
  }
  const plain = audit.plainLines.map((l) => resolveLine(l, info)).sort(compareResolved);
  if (plain.length > 0) {
    out.push("ITEMS WITHOUT CUSTOMIZATION:");
    for (const r of plain) out.push(`  ${r.line.quantity} × ${r.title} — ${[r.color, r.size && `Size ${r.size}`].filter(Boolean).join(", ")}`);
    out.push("");
  }
  if (audit.fees.length > 0) {
    out.push("CUSTOMIZATION CHARGED:");
    for (const f of audit.fees) out.push(`  ${FEE_KINDS[f.kind].label}: ${f.actualUnits} · ${money(f.actualAmount)}`);
  }
  return out.join("\n");
}
