// Stock is a garnish, not a gate: these thresholds only ever drive a badge.
// Nothing in this app uses qty to decide whether a variant renders.
export const AVAILABILITY_THRESHOLDS = {
  IN_STOCK_MIN: 6, // qty > 5
  LOW_STOCK_MIN: 1, // qty 1-5
} as const;

export type AvailabilityLevel = "in-stock" | "low-stock" | "made-to-order";

export interface Availability {
  level: AvailabilityLevel;
  label: string;
}

export function getAvailability(qty: number): Availability {
  if (qty >= AVAILABILITY_THRESHOLDS.IN_STOCK_MIN) {
    return { level: "in-stock", label: "In stock" };
  }
  if (qty >= AVAILABILITY_THRESHOLDS.LOW_STOCK_MIN) {
    return { level: "low-stock", label: "Low stock" };
  }
  return { level: "made-to-order", label: "Made to order" };
}

// One color's overall availability, summarized from its per-size rows: the
// most favorable level any size hits (so "is this color available at all"
// reads true if even one size is in stock) — the catalog-level answer to
// "is the color I want available", not a size-level breakdown.
export function summarizeColorAvailability(sizeQuantities: number[]): Availability {
  if (sizeQuantities.length === 0) return { level: "made-to-order", label: "Made to order" };
  const levels = new Set(sizeQuantities.map((qty) => getAvailability(qty).level));
  if (levels.has("in-stock")) return { level: "in-stock", label: "In stock" };
  if (levels.has("low-stock")) return { level: "low-stock", label: "Low stock" };
  return { level: "made-to-order", label: "Made to order" };
}

export type StockPillLevel = "in-stock" | "made-to-order";

export interface StockPill {
  level: StockPillLevel;
  label: string;
}

// The card-level stock pill collapses to the two states shoppers actually
// scan for — "in-stock" and "low-stock" both read as available.
export function getStockPill(sizeQuantities: number[]): StockPill {
  const summary = summarizeColorAvailability(sizeQuantities);
  return summary.level === "made-to-order"
    ? { level: "made-to-order", label: "Made to Order" }
    : { level: "in-stock", label: "In Stock" };
}
