/**
 * Shopify General delivery profile I/O for the per-unit shipping rates:
 * read (zones + rates + conditions), backup, write (deliveryProfileUpdate),
 * and conversion to the pure ObservedRate shape (lib/shipping-tiers.ts).
 * Needs the read_shipping / write_shipping scopes.
 */
import { appendFile, readFile, writeFile } from "fs/promises";
import path from "path";
import { shopifyGraphQL } from "@/lib/shopify";
import { FALLBACK_RATE_NAME, MAX_METHODS_PER_REQUEST, ZONES_PER_REQUEST } from "@/lib/shipping-config";
import { priceStr, r1, type ObservedRate, type WeightTier } from "@/lib/shipping-tiers";
import { weightInLb } from "@/lib/shopify-draft";

export const LOG_PATH = path.join(process.cwd(), "shipping-rates-log.jsonl");
export const ORIGINAL_PATH = path.join(process.cwd(), "shipping-rates-original.json");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface LiveCondition {
  id: string;
  field: "TOTAL_WEIGHT" | "TOTAL_PRICE";
  operator: "GREATER_THAN_OR_EQUAL_TO" | "LESS_THAN_OR_EQUAL_TO";
  /** Weight conditions: criteria value + unit as Shopify returned them. Price: amount + currency. */
  value: number;
  unit: string | null;
  currency: string | null;
}

export interface LiveMethod {
  id: string;
  name: string;
  active: boolean;
  description: string | null;
  /** DeliveryRateDefinition (flat rate we can recreate) vs DeliveryParticipant (carrier-calculated; never touched). */
  kind: "rate" | "participant";
  price: string | null;
  currency: string | null;
  conditions: LiveCondition[];
}

export interface LiveZone {
  id: string;
  name: string;
  methods: LiveMethod[];
}

export interface LiveProfile {
  id: string;
  name: string;
  version: number;
  locationGroupId: string;
  currency: string;
  zones: LiveZone[];
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await shopifyGraphQL<T>(query, variables);
    const throttled = res.errors?.some((e) => JSON.stringify(e).includes("THROTTLED"));
    if (throttled && attempt < 6) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    if (res.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(res.errors)}`);
    if (!res.data) throw new Error("GraphQL returned no data");
    return res.data;
  }
}

const PROFILE_QUERY = `
  query generalProfile($zAfter: String, $mAfter: String) {
    shop { currencyCode }
    deliveryProfiles(first: 20, merchantOwnedOnly: true) {
      nodes {
        id name default version
        profileLocationGroups {
          locationGroup { id }
          locationGroupZones(first: 1, after: $zAfter) {
            pageInfo { hasNextPage endCursor }
            nodes {
              zone { id name }
              methodDefinitions(first: 100, after: $mAfter) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id name active description
                  rateProvider {
                    __typename
                    ... on DeliveryRateDefinition { price { amount currencyCode } }
                  }
                  methodConditions {
                    id field operator
                    conditionCriteria {
                      __typename
                      ... on Weight { value unit }
                      ... on MoneyV2 { amount currencyCode }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface RawMethod {
  id: string;
  name: string;
  active: boolean;
  description: string | null;
  rateProvider: { __typename: string; price?: { amount: string; currencyCode: string } };
  methodConditions: {
    id: string;
    field: LiveCondition["field"];
    operator: LiveCondition["operator"];
    conditionCriteria: { __typename: string; value?: number; unit?: string; amount?: string; currencyCode?: string };
  }[];
}

interface RawPage {
  shop: { currencyCode: string };
  deliveryProfiles: {
    nodes: {
      id: string;
      name: string;
      default: boolean;
      version: number;
      profileLocationGroups: {
        locationGroup: { id: string };
        locationGroupZones: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: {
            zone: { id: string; name: string };
            methodDefinitions: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawMethod[] };
          }[];
        };
      }[];
    }[];
  };
}

function toMethod(m: RawMethod): LiveMethod {
  const isRate = m.rateProvider.__typename === "DeliveryRateDefinition";
  return {
    id: m.id,
    name: m.name,
    active: m.active,
    description: m.description,
    kind: isRate ? "rate" : "participant",
    price: m.rateProvider.price?.amount ?? null,
    currency: m.rateProvider.price?.currencyCode ?? null,
    conditions: m.methodConditions.map((c) => ({
      id: c.id,
      field: c.field,
      operator: c.operator,
      value: Number(c.conditionCriteria.value ?? c.conditionCriteria.amount),
      unit: c.conditionCriteria.unit ?? null,
      currency: c.conditionCriteria.currencyCode ?? null,
    })),
  };
}

/**
 * Reads the default ("General") profile: every zone and every rate with its
 * conditions. Pages zones one at a time and rates 100 at a time so the query
 * stays under Shopify's cost ceiling however many tiers exist.
 */
export async function readGeneralProfile(): Promise<LiveProfile> {
  let zAfter: string | null = null;
  let profile: LiveProfile | null = null;
  for (;;) {
    let mAfter: string | null = null;
    let zoneAcc: LiveZone | null = null;
    let zonePage: RawPage["deliveryProfiles"]["nodes"][number]["profileLocationGroups"][number]["locationGroupZones"] | null = null;
    for (;;) {
      const d: RawPage = await gql<RawPage>(PROFILE_QUERY, { zAfter, mAfter });
      const generals = d.deliveryProfiles.nodes.filter((p) => p.default);
      if (generals.length !== 1) throw new Error(`expected exactly one default delivery profile, found ${generals.length}`);
      const p = generals[0];
      if (p.profileLocationGroups.length !== 1) {
        throw new Error(`General profile has ${p.profileLocationGroups.length} location groups; this script supports exactly 1 — tell the maintainer`);
      }
      const lg = p.profileLocationGroups[0];
      profile ??= { id: p.id, name: p.name, version: p.version, locationGroupId: lg.locationGroup.id, currency: d.shop.currencyCode, zones: [] };
      zonePage = lg.locationGroupZones;
      const z = zonePage.nodes[0];
      if (!z) return profile; // profile with no zones
      zoneAcc ??= { id: z.zone.id, name: z.zone.name, methods: [] };
      zoneAcc.methods.push(...z.methodDefinitions.nodes.map(toMethod));
      if (!z.methodDefinitions.pageInfo.hasNextPage) break;
      mAfter = z.methodDefinitions.pageInfo.endCursor;
      await sleep(250);
    }
    profile!.zones.push(zoneAcc!);
    if (!zonePage!.pageInfo.hasNextPage) return profile!;
    zAfter = zonePage!.pageInfo.endCursor;
    await sleep(250);
  }
}

// --- derived views ---------------------------------------------------------

export function observedRates(zone: LiveZone): ObservedRate[] {
  return zone.methods
    .filter((m) => m.kind === "rate" && m.active && m.price !== null)
    .map((m) => {
      const w = m.conditions.filter((c) => c.field === "TOTAL_WEIGHT");
      const lb = (c: LiveCondition) => weightInLb({ value: c.value, unit: c.unit ?? "POUNDS" });
      const min = w.find((c) => c.operator === "GREATER_THAN_OR_EQUAL_TO");
      const max = w.find((c) => c.operator === "LESS_THAN_OR_EQUAL_TO");
      return {
        name: m.name,
        price: Number(m.price).toFixed(2),
        minLb: min ? r1(lb(min) ?? NaN) : null,
        maxLb: max ? r1(lb(max) ?? NaN) : null,
      };
    });
}

export const isFallback = (m: LiveMethod): boolean => m.name.trim().toLowerCase() === FALLBACK_RATE_NAME.toLowerCase();

/** Lowest weight at which this rate starts applying (null = applies from 0 lb / has no weight floor). */
export function fallbackFloorLb(m: LiveMethod): number | null {
  const c = m.conditions.find((x) => x.field === "TOTAL_WEIGHT" && x.operator === "GREATER_THAN_OR_EQUAL_TO");
  return c ? weightInLb({ value: c.value, unit: c.unit ?? "POUNDS" }) : null;
}

// --- backup / log ------------------------------------------------------------

export async function logEvent(event: Record<string, unknown>): Promise<void> {
  await appendFile(LOG_PATH, JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n");
}

/**
 * Writes shipping-rates-original.json ONLY if it doesn't exist yet, so it is
 * always the true pre-change state (later runs would otherwise back up
 * already-modified rates). Every call also logs the snapshot to the jsonl log.
 */
export async function ensureOriginalBackup(profile: LiveProfile): Promise<{ created: boolean; path: string }> {
  await logEvent({ event: "snapshot", profile });
  try {
    await readFile(ORIGINAL_PATH, "utf8");
    return { created: false, path: ORIGINAL_PATH };
  } catch {
    await writeFile(ORIGINAL_PATH, JSON.stringify(profile, null, 2));
    return { created: true, path: ORIGINAL_PATH };
  }
}

export async function readOriginalBackup(): Promise<LiveProfile> {
  return JSON.parse(await readFile(ORIGINAL_PATH, "utf8")) as LiveProfile;
}

// --- writes ------------------------------------------------------------------

export interface MethodCreate {
  name: string;
  description?: string | null;
  active: boolean;
  rateDefinition: { price: { amount: string; currencyCode: string } };
  weightConditionsToCreate?: { operator: string; criteria: { value: number; unit: "POUNDS" } }[];
  priceConditionsToCreate?: { operator: string; criteria: { amount: string; currencyCode: string } }[];
}

export function tierMethod(name: string, perUnit: number, t: WeightTier, currency: string): MethodCreate {
  return {
    name,
    active: true,
    rateDefinition: { price: { amount: priceStr(t.units, perUnit), currencyCode: currency } },
    weightConditionsToCreate: [
      { operator: "GREATER_THAN_OR_EQUAL_TO", criteria: { value: t.minLb, unit: "POUNDS" } },
      { operator: "LESS_THAN_OR_EQUAL_TO", criteria: { value: t.maxLb, unit: "POUNDS" } },
    ],
  };
}

/** Rebuilds a recorded original rate (weight + price conditions) for --rollback. */
export function methodFromLive(m: LiveMethod, fallbackCurrency: string): MethodCreate {
  const weightToLb = (c: LiveCondition) => weightInLb({ value: c.value, unit: c.unit ?? "POUNDS" }) ?? c.value;
  return {
    name: m.name,
    ...(m.description ? { description: m.description } : {}),
    active: m.active,
    rateDefinition: { price: { amount: Number(m.price).toFixed(2), currencyCode: m.currency ?? fallbackCurrency } },
    weightConditionsToCreate: m.conditions
      .filter((c) => c.field === "TOTAL_WEIGHT")
      .map((c) => ({ operator: c.operator, criteria: { value: r1(weightToLb(c)), unit: "POUNDS" as const } })),
    priceConditionsToCreate: m.conditions
      .filter((c) => c.field === "TOTAL_PRICE")
      .map((c) => ({ operator: c.operator, criteria: { amount: c.value.toFixed(2), currencyCode: c.currency ?? fallbackCurrency } })),
  };
}

export interface ZoneWork {
  zoneId: string;
  zoneName: string;
  deleteIds: string[];
  create: MethodCreate[];
}

const UPDATE = `
  mutation shipUpdate($id: ID!, $profile: DeliveryProfileInput!) {
    deliveryProfileUpdate(id: $id, profile: $profile) {
      profile { id version }
      userErrors { field message }
    }
  }
`;

export interface UpdateResult {
  ok: boolean;
  errors: { field: string[] | null; message: string }[];
}

/** One deliveryProfileUpdate for the given zones (callers keep this to <= ZONES_PER_REQUEST zones). */
export async function sendUpdate(profile: LiveProfile, work: ZoneWork[]): Promise<UpdateResult> {
  const input = {
    locationGroupsToUpdate: [
      {
        id: profile.locationGroupId,
        zonesToUpdate: work.map((w) => ({ id: w.zoneId, ...(w.create.length > 0 ? { methodDefinitionsToCreate: w.create } : {}) })),
      },
    ],
    ...(work.some((w) => w.deleteIds.length > 0) ? { methodDefinitionsToDelete: work.flatMap((w) => w.deleteIds) } : {}),
  };
  const d = await gql<{ deliveryProfileUpdate: { userErrors: UpdateResult["errors"] } }>(UPDATE, { id: profile.id, profile: input });
  const errors = d.deliveryProfileUpdate.userErrors;
  await logEvent({
    event: "update",
    zones: work.map((w) => w.zoneId),
    created: work.reduce((n, w) => n + w.create.length, 0),
    deleted: work.reduce((n, w) => n + w.deleteIds.length, 0),
    errors,
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Splits work into requests: <= ZONES_PER_REQUEST zones and <= MAX_METHODS_PER_REQUEST
 * created rates each. A zone bigger than the cap is chunked across requests
 * (its deletes ride in its first chunk).
 */
export function planRequests(work: ZoneWork[]): ZoneWork[][] {
  const requests: ZoneWork[][] = [];
  let cur: ZoneWork[] = [];
  let curN = 0;
  const flush = () => {
    if (cur.length > 0) requests.push(cur);
    cur = [];
    curN = 0;
  };
  for (const w of work) {
    let rest = w.create;
    let deletes = w.deleteIds;
    do {
      const room = MAX_METHODS_PER_REQUEST - curN;
      if (room <= 0 || cur.length >= ZONES_PER_REQUEST) flush();
      const take = rest.slice(0, MAX_METHODS_PER_REQUEST - curN);
      cur.push({ zoneId: w.zoneId, zoneName: w.zoneName, deleteIds: deletes, create: take });
      curN += take.length;
      rest = rest.slice(take.length);
      deletes = [];
      if (rest.length > 0) flush();
    } while (rest.length > 0);
  }
  flush();
  return requests;
}

export const sleepMs = sleep;
