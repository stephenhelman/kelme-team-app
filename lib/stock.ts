import type { RawSkuSheet } from "@/lib/kelme";

const HEADQUARTERS_LABEL = "Headquarters Inventory";

export interface SkuSheetEntry {
  colorCode: string;
  colorName: string;
  kelmeSize: string;
  qty: number;
}

// A spreadsheet grid, cells keyed "row:col". Each color gets 3 rows starting
// at a qtyRow index R: R = "Order Quantity" (ignored), R+1 = "Headquarters
// Inventory" (the stock we want), R+2 = "Pending Inventory" (ignored). Size
// headers live in row 0 at each sizeCol index, newline-separated (KELME size
// first). colorContrast maps the row-0 label ("{styleCode}{ColorName},{code}")
// to the color code — this is where colorCode truth comes from, never the
// product detail's `colors` CSV. Confirmed against a live b2b.pdt.sheet
// response.
//
// The size label here is the raw Kelme value, untouched — a bare number like
// "110" or "4" is ambiguous on its own (kids height in cm vs. a ball size);
// resolving that ambiguity needs product-level context (name/category) that
// this parser doesn't have, so it's left to the caller (lib/kelme-capture.ts).
export function parseSkuSheet(raw: RawSkuSheet, styleCode: string): SkuSheetEntry[] {
  try {
    const def = raw?.def;
    const config = def?.config;
    const cells = def?.cells;
    if (!config?.sizeCol?.length || !config?.qtyRow?.length || !cells) return [];

    const sizeLabels = new Map<number, string>();
    for (const col of config.sizeCol) {
      const header = cells[`0:${col}`]?.v ?? "";
      const label = header.split(/\r?\n/)[0]?.trim();
      if (label) sizeLabels.set(col, label);
    }

    const entries: SkuSheetEntry[] = [];

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
        entries.push({ colorCode, colorName, kelmeSize: size, qty });
      }
    }
    return entries;
  } catch {
    return [];
  }
}
