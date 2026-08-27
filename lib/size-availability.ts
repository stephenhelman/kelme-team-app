import type { StockEntry } from "./types";
import { sizeSortKey } from "./size-sort";

// Unlike lib/availability.ts (a catalog-level "in stock" / "made to order"
// badge derived purely from qty), this is the per-size-button state for a
// specific color: "unavailable" means this color doesn't carry that size at
// all (no StockEntry row) — a real gate, not a garnish — while qty alone
// (present but 0) still reads as orderable, just build-to-order.
export type SizeStatus = "in-stock" | "made-to-order" | "unavailable";

export function getAllSizes(stock: StockEntry[]): string[] {
  return [...new Set(stock.map((s) => s.size))].sort(
    (a, b) => sizeSortKey(a)[0] - sizeSortKey(b)[0] || a.localeCompare(b),
  );
}

export function getSizeStatus(stock: StockEntry[], color: string, size: string): SizeStatus {
  const entry = stock.find((s) => s.color === color && s.size === size);
  if (!entry) return "unavailable";
  return entry.qty > 0 ? "in-stock" : "made-to-order";
}
