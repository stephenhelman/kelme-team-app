/**
 * Pure tier math for per-unit shipping (no I/O). A cart's weight in lb equals
 * its core unit count (core = 1 lb, fee items = 0 lb), so shipping is a
 * weight-tier lookup. Constants live in lib/shipping-config.ts.
 */
import {
  EXACT_UP_TO,
  EXPRESS_NAME,
  EXPRESS_RATE_PER_UNIT,
  MAX_UNITS,
  STANDARD_NAME,
  STANDARD_RATE_PER_UNIT,
  STEP_UNITS,
} from "@/lib/shipping-config";

export interface WeightTier {
  /** Inclusive lower bound, lb. */
  minLb: number;
  /** Inclusive upper bound, lb. */
  maxLb: number;
  /** Largest unit count this tier covers; price = units * per-unit rate (upper edge, never undercharges). */
  units: number;
}

export interface ServiceSpec {
  name: string;
  perUnit: number;
}

export const SERVICES: ServiceSpec[] = [
  { name: STANDARD_NAME, perUnit: STANDARD_RATE_PER_UNIT },
  { name: EXPRESS_NAME, perUnit: EXPRESS_RATE_PER_UNIT },
];

/** Round to 1 dp: all bounds are n +/- 0.5 / 0.4, so 1 dp is exact and kills float noise. */
export const r1 = (n: number): number => Math.round(n * 10) / 10;
export const r2 = (n: number): number => Math.round(n * 100) / 100;
export const priceStr = (units: number, perUnit: number): string => r2(units * perUnit).toFixed(2);

/** Exact tier for n units: >= n-0.5 and <= n+0.4 lb. */
export function exactTier(n: number): WeightTier {
  return { minLb: r1(n - 0.5), maxLb: r1(n + 0.4), units: n };
}

/** Stepped tier covering (prevTop, top] units: >= prevTop+0.5 and <= top+0.4 lb, priced at `top`. */
export function stepTier(prevTop: number, top: number): WeightTier {
  return { minLb: r1(prevTop + 0.5), maxLb: r1(top + 0.4), units: top };
}

/** Exact tiers 1..exactUpTo, then steps of STEP_UNITS up to maxUnits (last step may be shorter). */
export function buildTiers(exactUpTo = EXACT_UP_TO, maxUnits = MAX_UNITS): WeightTier[] {
  const tiers: WeightTier[] = [];
  for (let n = 1; n <= Math.min(exactUpTo, maxUnits); n++) tiers.push(exactTier(n));
  let prev = Math.min(exactUpTo, maxUnits);
  while (prev < maxUnits) {
    const top = Math.min(prev + STEP_UNITS, maxUnits);
    tiers.push(stepTier(prev, top));
    prev = top;
  }
  return tiers;
}

/** Independent of buildTiers: the unit count a cart of u units is priced at. null above MAX_UNITS. */
export function pricedUnits(u: number, exactUpTo = EXACT_UP_TO, maxUnits = MAX_UNITS): number | null {
  if (u < 1 || u > maxUnits) return null;
  if (u <= exactUpTo) return u;
  return Math.min(exactUpTo + Math.ceil((u - exactUpTo) / STEP_UNITS) * STEP_UNITS, maxUnits);
}

export const expectedPrice = (u: number, perUnit: number, exactUpTo = EXACT_UP_TO, maxUnits = MAX_UNITS): string | null => {
  const p = pricedUnits(u, exactUpTo, maxUnits);
  return p === null ? null : priceStr(p, perUnit);
};

/** A rate as read back from Shopify (weights normalised to lb, null = no bound). */
export interface ObservedRate {
  name: string;
  price: string;
  minLb: number | null;
  maxLb: number | null;
}

/** Does a cart of `weightLb` qualify for this rate? Mirrors Shopify's inclusive >= / <= conditions. */
export const applies = (r: ObservedRate, weightLb: number): boolean =>
  (r.minLb === null || weightLb >= r.minLb - 1e-9) && (r.maxLb === null || weightLb <= r.maxLb + 1e-9);

export interface Mismatch {
  zone: string;
  what: string;
}

/** Tier-by-tier comparison of the desired ladder against what is live in one zone. */
export function diffLadder(zone: string, observed: ObservedRate[], tiers: WeightTier[]): Mismatch[] {
  const out: Mismatch[] = [];
  for (const svc of SERVICES) {
    const live = observed.filter((r) => r.name.toLowerCase() === svc.name.toLowerCase());
    const used = new Set<ObservedRate>();
    for (const t of tiers) {
      const want = priceStr(t.units, svc.perUnit);
      const m = live.find((r) => r.minLb !== null && r.maxLb !== null && r1(r.minLb) === t.minLb && r1(r.maxLb) === t.maxLb);
      if (!m) {
        out.push({ zone, what: `${svc.name} tier ${t.minLb}-${t.maxLb} lb (${t.units}u, $${want}) is MISSING` });
        continue;
      }
      used.add(m);
      if (m.price !== want) out.push({ zone, what: `${svc.name} tier ${t.minLb}-${t.maxLb} lb price $${m.price}, expected $${want}` });
    }
    for (const r of live) if (!used.has(r)) out.push({ zone, what: `${svc.name} has an UNEXPECTED rate ${r.minLb}-${r.maxLb} lb $${r.price}` });
  }
  return out;
}

/** Simulated checkout for each cart size: exactly one rate per service at the expected price. */
export function checkCarts(zone: string, observed: ObservedRate[], carts: number[], exactUpTo = EXACT_UP_TO, maxUnits = MAX_UNITS): Mismatch[] {
  const out: Mismatch[] = [];
  for (const u of carts) {
    for (const svc of SERVICES) {
      const hits = observed.filter((r) => r.name.toLowerCase() === svc.name.toLowerCase() && applies(r, u));
      const want = expectedPrice(u, svc.perUnit, exactUpTo, maxUnits);
      if (hits.length !== 1) out.push({ zone, what: `cart ${u}u: ${svc.name} matched ${hits.length} rates (${hits.map((h) => "$" + h.price).join(", ") || "none"}), expected exactly 1 at $${want}` });
      else if (hits[0].price !== want) out.push({ zone, what: `cart ${u}u: ${svc.name} $${hits[0].price}, expected $${want}` });
    }
  }
  return out;
}
