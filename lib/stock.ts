import { buildColorImageUrl, checkImageExists, type RawSkuSheet } from "./kelme";
import type { StockEntry } from "./types";

const HEADQUARTERS_LABEL = "Headquarters Inventory";
const FOB_FORMULA_PATTERN = /amt\(([\d.]+),/;

// Kids gear is sized by height in cm ("110", "120"...) rather than
// letter sizes — label it "110cm" so shoppers don't mistake it for a code.
// Letter sizes (S, M, 2XL...) pass through untouched.
function formatSizeLabel(label: string): string {
  return /^\d+$/.test(label) ? `${label}cm` : label;
}

/**
 * Parses a b2b.pdt.sheet response (confirmed shape — see the SkuSheetCell
 * comment in lib/kelme.ts) into flat color x size stock rows, reading only
 * the "Headquarters Inventory" row beneath each color's order-entry row.
 */
export function parseSkuSheet(raw: RawSkuSheet, styleCode: string): StockEntry[] {
  try {
    const def = raw.def;
    const config = def?.config;
    const cells = def?.cells;
    if (!config?.sizeCol?.length || !config.qtyRow?.length || !cells) return [];

    const sizeLabels = new Map<number, string>();
    for (const col of config.sizeCol) {
      const header = cells[`0:${col}`]?.v ?? "";
      const label = header.split(/\r?\n/)[0]?.trim();
      if (label) sizeLabels.set(col, formatSizeLabel(label));
    }

    const entries: StockEntry[] = [];

    for (const row of config.qtyRow) {
      const stockRow = row + 1;
      if (!(cells[`${stockRow}:1`]?.v ?? "").includes(HEADQUARTERS_LABEL)) continue;

      const rawLabel = cells[`${row}:0`]?.v ?? "";
      const colorCode = config.colorContrast[rawLabel] ?? "";
      const colorName = rawLabel.startsWith(styleCode)
        ? rawLabel.slice(styleCode.length, rawLabel.lastIndexOf(",")).trim() || rawLabel
        : rawLabel;

      for (const [col, size] of sizeLabels) {
        const qty = Number(cells[`${stockRow}:${col}`]?.v || 0);
        if (!Number.isFinite(qty)) continue;
        entries.push({ color: colorName, colorCode, size, qty });
      }
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Server-side reachability check for every distinct color in a stock list —
 * run once at seed/refresh time, never live on click. Returns colorCode ->
 * resolved image URL, or null if {styleCode}_{colorCode}_01.jpg 404s.
 */
export async function buildColorImageMap(
  styleCode: string,
  entries: StockEntry[],
): Promise<Record<string, string | null>> {
  const colorCodes = [...new Set(entries.map((e) => e.colorCode).filter(Boolean))];

  const results = await Promise.all(
    colorCodes.map(async (colorCode) => {
      const url = buildColorImageUrl(styleCode, colorCode);
      const exists = await checkImageExists(url);
      return [colorCode, exists ? url : null] as const;
    }),
  );

  return Object.fromEntries(results);
}

/**
 * The FOB Xiamen unit cost isn't a discrete field — it's a constant baked
 * into every "Sum Amt" formula cell (amt(7.3, ...)). Pull it from the first
 * formula cell that has one; null if the sheet has none (accessories, etc).
 */
export function extractFobCost(raw: RawSkuSheet): number | null {
  const cells = raw.def?.cells;
  if (!cells) return null;

  for (const cell of Object.values(cells)) {
    if (cell.t !== "f" || !cell.f) continue;
    const match = cell.f.match(FOB_FORMULA_PATTERN);
    if (match) return Number(match[1]);
  }
  return null;
}
