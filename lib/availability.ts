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
