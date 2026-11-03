/**
 * Order audit: classifies an order's lines (core / customization-fee / other),
 * reads each customized line's properties, recomputes the customization fees
 * the order SHOULD carry, and compares them to the fee lines actually on it.
 * Pure — no I/O; tags and variant info are passed in (see order-file-worker).
 */
import {
  CORE_TAG,
  FEE_KINDS,
  FEE_KIND_ORDER,
  FEE_TAG,
  LOGO_URL_HOSTS,
  MIN_CORE_ITEMS,
  PLACEMENT_MULTIPLIERS,
  type FeeKind,
} from "./order-config";
import type { OrderLineItem, OrderPayload } from "./order-types";

export interface RosterEntry {
  n: number | null;
  number: string;
  name: string;
  size: string;
  color: string;
}

export interface CustomizedLine {
  line: OrderLineItem;
  logoUrl: string | null;
  /** logoUrl passed host/scheme validation and is safe to render/link. */
  logoUrlSafe: boolean;
  logoApplication: "Patch" | "Heat Transfer" | null;
  logoPlacement: string;
  numberPlacement: string;
  printColor: string;
  customizeFields: string[];
  rosterStatus: string;
  roster: RosterEntry[];
  rosterParseError: boolean;
  hasRosterProp: boolean;
}

export interface ExpectedFee {
  kind: FeeKind;
  units: number;
  amount: number;
}

export interface FeeSummaryRow {
  kind: FeeKind;
  expectedUnits: number;
  expectedAmount: number;
  actualUnits: number;
  actualAmount: number;
}

export type AuditFlagCode =
  | "LOW_CORE_COUNT"
  | "FEE_SHORTFALL"
  | "FEES_MISSING"
  | "ROSTER_PENDING"
  | "ROSTER_COUNT_MISMATCH"
  | "ROSTER_UNPARSEABLE"
  | "LOGO_APPLICATION_MISSING"
  | "LOGO_URL_SUSPICIOUS"
  | "UNKNOWN_PLACEMENT"
  | "UNRECOGNIZED_FEE_LINE"
  | "UNCLASSIFIED_LINE";

export interface AuditFlag {
  code: AuditFlagCode;
  message: string;
  /** Dollars short, for fee flags. */
  shortfall?: number;
  lineId?: number;
}

export interface AuditResult {
  flags: AuditFlag[];
  coreCount: number;
  coreLines: OrderLineItem[];
  otherLines: OrderLineItem[];
  feeLines: OrderLineItem[];
  customized: CustomizedLine[];
  /** Core/other lines with no customization properties. */
  plainLines: OrderLineItem[];
  fees: FeeSummaryRow[];
}

export type TagsByProductId = Map<number, string[]>;

// --- parsing ---------------------------------------------------------------

function prop(line: OrderLineItem, name: string): string {
  const p = line.properties.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
  return p?.value.trim() ?? "";
}

export function parseRoster(raw: string): { roster: RosterEntry[]; error: boolean } {
  if (!raw) return { roster: [], error: false };
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return { roster: [], error: true };
    return {
      error: false,
      roster: arr.map((e: Record<string, unknown>, i: number) => ({
        n: typeof e?.n === "number" ? e.n : i + 1,
        number: e?.number == null ? "" : String(e.number).trim(),
        name: e?.name == null ? "" : String(e.name).trim(),
        size: e?.size == null ? "" : String(e.size).trim(),
        color: e?.color == null ? "" : String(e.color).trim(),
      })),
    };
  } catch {
    return { roster: [], error: true };
  }
}

export function isSafeLogoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && LOGO_URL_HOSTS.includes(u.hostname) && u.pathname.includes("/uploads/");
  } catch {
    return false;
  }
}

/** Returns null when the line carries no customization properties at all. */
export function parseCustomization(line: OrderLineItem): CustomizedLine | null {
  const logoUrl = prop(line, "Logo") || null;
  const appRaw = prop(line, "Logo Application");
  const rosterRaw = prop(line, "_roster");
  const fieldsRaw = prop(line, "_customize_fields");
  if (!logoUrl && !appRaw && !rosterRaw && !fieldsRaw) return null;

  const { roster, error } = parseRoster(rosterRaw);
  const app = /^patch$/i.test(appRaw) ? "Patch" : /^heat\s*transfer$/i.test(appRaw) ? "Heat Transfer" : null;
  return {
    line,
    logoUrl,
    logoUrlSafe: !!logoUrl && isSafeLogoUrl(logoUrl),
    logoApplication: app,
    logoPlacement: prop(line, "Logo Placement"),
    numberPlacement: prop(line, "Number Placement"),
    printColor: prop(line, "Print Color"),
    customizeFields: fieldsRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
    rosterStatus: prop(line, "_roster_status").toLowerCase(),
    roster,
    rosterParseError: error,
    hasRosterProp: !!rosterRaw,
  };
}

// --- fee math --------------------------------------------------------------

export function digitCount(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

/** Multiplier for a placement value; `known` is false for a non-blank value we haven't confirmed. */
export function placementMultiplier(value: string): { multiplier: number; known: boolean } {
  const v = value.trim().toLowerCase();
  if (!v) return { multiplier: 1, known: true };
  if (v in PLACEMENT_MULTIPLIERS) return { multiplier: PLACEMENT_MULTIPLIERS[v], known: true };
  return { multiplier: 1, known: false };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Fees one customized line should carry. Number/name fees come from what's in
 * the roster (digits / named entries), not from _customize_fields, so a
 * roster carrying a name the fields flag doesn't mention still gets billed.
 */
export function expectedFeesForLine(c: CustomizedLine): ExpectedFee[] {
  const out: ExpectedFee[] = [];
  const logoMult = placementMultiplier(c.logoPlacement).multiplier;
  const numMult = placementMultiplier(c.numberPlacement).multiplier;

  if (c.logoUrl && c.logoApplication) {
    const kind: FeeKind = c.logoApplication === "Patch" ? "patch" : "heat";
    const units = c.line.quantity * logoMult;
    out.push({ kind, units, amount: round2(units * FEE_KINDS[kind].rate) });
  }
  const digits = c.roster.reduce((sum, e) => sum + digitCount(e.number), 0);
  if (digits > 0) {
    const units = digits * numMult;
    out.push({ kind: "number", units, amount: round2(units * FEE_KINDS.number.rate) });
  }
  const names = c.roster.filter((e) => e.name).length;
  if (names > 0) out.push({ kind: "name", units: names, amount: round2(names * FEE_KINDS.name.rate) });
  return out;
}

export function feeKindOf(line: OrderLineItem): FeeKind | null {
  return FEE_KIND_ORDER.find((k) => FEE_KINDS[k].titlePattern.test(line.title)) ?? null;
}

const money = (n: number) => `$${n.toFixed(2)}`;

// --- audit -----------------------------------------------------------------

export function auditOrder(order: OrderPayload, tags: TagsByProductId): AuditResult {
  const flags: AuditFlag[] = [];
  const coreLines: OrderLineItem[] = [];
  const otherLines: OrderLineItem[] = [];
  const feeLines: OrderLineItem[] = [];

  for (const line of order.line_items) {
    const t = (line.product_id != null ? tags.get(line.product_id) : undefined)?.map((x) => x.toLowerCase());
    if (t?.includes(FEE_TAG)) feeLines.push(line);
    else if (t?.includes(CORE_TAG)) coreLines.push(line);
    else {
      otherLines.push(line);
      if (!t) {
        flags.push({
          code: "UNCLASSIFIED_LINE",
          lineId: line.id,
          message: `Couldn't look up the product tags for "${line.title}", so it isn't counted as a core item.`,
        });
      }
    }
  }

  const coreCount = coreLines.reduce((s, l) => s + l.quantity, 0);
  if (coreCount < MIN_CORE_ITEMS) {
    flags.push({
      code: "LOW_CORE_COUNT",
      message: `Only ${coreCount} core item${coreCount === 1 ? "" : "s"} on this order — the minimum is ${MIN_CORE_ITEMS}.`,
    });
  }

  // Customization on the non-fee lines.
  const customized: CustomizedLine[] = [];
  const plainLines: OrderLineItem[] = [];
  for (const line of [...coreLines, ...otherLines]) {
    const c = parseCustomization(line);
    if (c) customized.push(c);
    else plainLines.push(line);
  }

  // Roster / property checks per customized line.
  for (const c of customized) {
    const label = c.line.title + (c.line.variant_title ? ` (${c.line.variant_title})` : "");
    const lineId = c.line.id;

    if (c.rosterParseError) {
      flags.push({ code: "ROSTER_UNPARSEABLE", lineId, message: `The player list for ${label} couldn't be read.` });
    }
    if (c.rosterStatus === "pending") {
      flags.push({
        code: "ROSTER_PENDING",
        lineId,
        message: `The player list for ${label} is still pending — the customer hasn't finished entering it.`,
      });
    }
    const expectsRoster = c.customizeFields.length > 0 || c.hasRosterProp;
    if (expectsRoster && !c.rosterParseError && c.rosterStatus !== "pending" && c.roster.length !== c.line.quantity) {
      flags.push({
        code: "ROSTER_COUNT_MISMATCH",
        lineId,
        message: `${label}: ${c.line.quantity} ordered but ${c.roster.length} player${c.roster.length === 1 ? "" : "s"} listed.`,
      });
    }
    if (c.logoUrl && !c.logoApplication) {
      flags.push({
        code: "LOGO_APPLICATION_MISSING",
        lineId,
        message: `${label} has a logo but no valid application (Patch / Heat Transfer), so its logo fee can't be checked.`,
      });
    }
    if (c.logoUrl && !c.logoUrlSafe) {
      flags.push({
        code: "LOGO_URL_SUSPICIOUS",
        lineId,
        message: `The logo link on ${label} is not a Shopify upload, so it is shown as plain text and not linked.`,
      });
    }
    for (const [field, value] of [["Logo Placement", c.logoPlacement], ["Number Placement", c.numberPlacement]] as const) {
      if (!placementMultiplier(value).known) {
        flags.push({
          code: "UNKNOWN_PLACEMENT",
          lineId,
          message: `${label}: ${field} "${value}" isn't a recognised value — fees were checked as if it were a single placement.`,
        });
      }
    }
  }

  // Fees: expected (recomputed) vs actual (fee lines on the order).
  const expected = new Map<FeeKind, { units: number; amount: number }>();
  for (const c of customized) {
    for (const f of expectedFeesForLine(c)) {
      const cur = expected.get(f.kind) ?? { units: 0, amount: 0 };
      expected.set(f.kind, { units: cur.units + f.units, amount: round2(cur.amount + f.amount) });
    }
  }
  const actual = new Map<FeeKind, { units: number; amount: number }>();
  for (const line of feeLines) {
    const kind = feeKindOf(line);
    if (!kind) {
      flags.push({
        code: "UNRECOGNIZED_FEE_LINE",
        lineId: line.id,
        message: `A fee line "${line.title}" doesn't match any known fee type (patch, heat transfer, number, name).`,
      });
      continue;
    }
    const cur = actual.get(kind) ?? { units: 0, amount: 0 };
    actual.set(kind, {
      units: cur.units + line.quantity,
      amount: round2(cur.amount + line.quantity * Number(line.price)),
    });
  }

  const fees: FeeSummaryRow[] = FEE_KIND_ORDER.filter((k) => expected.has(k) || actual.has(k)).map((kind) => ({
    kind,
    expectedUnits: expected.get(kind)?.units ?? 0,
    expectedAmount: expected.get(kind)?.amount ?? 0,
    actualUnits: actual.get(kind)?.units ?? 0,
    actualAmount: actual.get(kind)?.amount ?? 0,
  }));

  const totalExpected = round2(fees.reduce((s, f) => s + f.expectedAmount, 0));
  if (customized.length > 0 && totalExpected > 0 && feeLines.length === 0) {
    flags.push({
      code: "FEES_MISSING",
      shortfall: totalExpected,
      message: `This order has customization but no customization fees were charged. Expected ${money(totalExpected)}.`,
    });
  } else {
    for (const f of fees) {
      const diff = round2(f.expectedAmount - f.actualAmount);
      if (diff > 0 || f.actualUnits < f.expectedUnits) {
        const cfg = FEE_KINDS[f.kind];
        flags.push({
          code: "FEE_SHORTFALL",
          shortfall: Math.max(diff, 0),
          message:
            `${cfg.label} fee is short: expected ${f.expectedUnits} × ${money(cfg.rate)} = ${money(f.expectedAmount)}, ` +
            `charged ${f.actualUnits} (${money(f.actualAmount)})` +
            (diff > 0 ? ` — short by ${money(diff)}.` : "."),
        });
      }
    }
  }

  return { flags, coreCount, coreLines, otherLines, feeLines, customized, plainLines, fees };
}
