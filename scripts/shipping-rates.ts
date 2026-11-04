/**
 * Per-unit shipping rates as weight tiers on the General delivery profile.
 * Core variants weigh 1 lb and fee items 0 lb (npm run shipping:weights), so
 * cart weight == core unit count. DRY-RUN by default; every write needs --execute.
 *
 *   npm run shipping:rates                       # dry-run of the full run (per-zone diff)
 *   npm run shipping:rates -- --execute          # (add --fix-fallback if "Request a quote" has no weight floor)
 *                                                # backs up, replaces Standard/Express tiers, verifies
 *   npm run shipping:rates -- --verify           # read-only: compare live profile to expected
 *   npm run shipping:rates -- --canary --zone <id> [--max-units 300] [--execute]
 *                                                # ramp exact tiers on ONE zone until Shopify rejects
 *                                                # (or max), report the cap, then roll the canary back
 *   npm run shipping:rates -- --rollback [--execute]   # restore shipping-rates-original.json
 *
 * Original rates are recorded in shipping-rates-original.json (written once,
 * before the first change) and every snapshot/update goes to shipping-rates-log.jsonl.
 * "Request a quote" is never touched; it must start above the top tier.
 * Needs read_shipping + write_shipping (re-auth via /shopify/auth).
 */
import {
  CANARY_PREFIX,
  CANARY_RAMP_UNITS,
  EXACT_UP_TO,
  FALLBACK_RATE_NAME,
  MAX_UNITS,
} from "@/lib/shipping-config";
import {
  buildTiers,
  checkCarts,
  diffLadder,
  exactTier,
  r1,
  SERVICES,
  type Mismatch,
} from "@/lib/shipping-tiers";
import {
  ensureOriginalBackup,
  fallbackFloorLb,
  isFallback,
  logEvent,
  methodFromLive,
  observedRates,
  planRequests,
  readGeneralProfile,
  readOriginalBackup,
  sendUpdate,
  sleepMs,
  tierMethod,
  type LiveProfile,
  type LiveZone,
  type MethodCreate,
  type ZoneWork,
} from "@/lib/shipping-profile";

const flag = (n: string) => process.argv.includes(`--${n}`);
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const VERIFY_CARTS = [25, 26, 40, 137, MAX_UNITS];
const PACING_MS = 500;

const ours = (name: string) => SERVICES.some((s) => s.name.toLowerCase() === name.trim().toLowerCase());
const isCanary = (name: string) => name.startsWith(CANARY_PREFIX);

function zoneIdMatches(z: LiveZone, wanted: string): boolean {
  return z.id === wanted || z.id.endsWith(`/${wanted}`);
}

function describeZone(z: LiveZone): string {
  const rates = z.methods.filter((m) => m.kind === "rate").length;
  return `${z.name} [${z.id.split("/").pop()}] — ${z.methods.length} rates (${rates} flat, ${z.methods.length - rates} carrier)`;
}

// --- verify (step 6) -----------------------------------------------------------

function verifyProfile(profile: LiveProfile): Mismatch[] {
  const tiers = buildTiers();
  const out: Mismatch[] = [];
  console.log(`verify: ${profile.zones.length} zones; carts ${VERIFY_CARTS.join(", ")} (fee lines at 0 lb => weight == units)`);
  for (const z of profile.zones) {
    const obs = observedRates(z);
    const ladder = diffLadder(z.name, obs, tiers);
    const carts = checkCarts(z.name, obs, VERIFY_CARTS);
    const fb = z.methods.filter(isFallback);
    const fbProblems: Mismatch[] = [];
    if (fb.length === 0) fbProblems.push({ zone: z.name, what: `"${FALLBACK_RATE_NAME}" fallback is MISSING` });
    for (const f of fb) {
      const floor = fallbackFloorLb(f);
      if (floor === null || floor <= tiers.at(-1)!.maxLb) fbProblems.push({ zone: z.name, what: `"${FALLBACK_RATE_NAME}" floor is ${floor ?? "none"} lb; must be > ${tiers.at(-1)!.maxLb} lb or it shows alongside tiers` });
    }
    const all = [...ladder, ...carts, ...fbProblems];
    const standard25 = obs.find((r) => r.name === "Standard Shipping" && r.minLb === 24.5);
    console.log(`  ${all.length === 0 ? "OK  " : "FAIL"} ${z.name}: ${obs.length} live tier rates${standard25 ? `, 25u Standard $${standard25.price}` : ""}`);
    out.push(...all);
  }
  if (out.length === 0) console.log("VERIFY OK — every tier boundary and cart matches.");
  else {
    console.log(`VERIFY MISMATCHES (${out.length}):`);
    for (const m of out.slice(0, 300)) console.log(`  [${m.zone}] ${m.what}`);
  }
  return out;
}

// --- full run (step 5) -----------------------------------------------------------

async function fullRun(execute: boolean) {
  const profile = await readGeneralProfile();
  const tiers = buildTiers();
  const topMax = tiers.at(-1)!.maxLb;
  console.log(`profile "${profile.name}" (${profile.id}), currency ${profile.currency}, ${profile.zones.length} zones`);
  console.log(`ladder: exact 1..${EXACT_UP_TO}, steps of 5 to ${MAX_UNITS}u = ${tiers.length} tiers x ${SERVICES.length} services = ${tiers.length * SERVICES.length} rates/zone; top tier <= ${topMax} lb`);

  const blockers: string[] = [];
  const work: ZoneWork[] = [];
  for (const z of profile.zones) {
    const canary = z.methods.filter((m) => isCanary(m.name));
    if (canary.length > 0) blockers.push(`zone ${z.name} still has ${canary.length} CANARY rates — run --canary cleanup via --rollback first`);
    const replace = z.methods.filter((m) => m.kind === "rate" && ours(m.name));
    const keep = z.methods.filter((m) => !replace.includes(m));
    const fb = keep.filter(isFallback);
    const fbDelete: string[] = [];
    const fbCreate: MethodCreate[] = [];
    for (const f of fb) {
      const floor = fallbackFloorLb(f);
      if (floor !== null && floor > topMax) continue;
      if (flag("fix-fallback")) {
        // Same rate re-created with a weight floor just above the top tier (delete + create: atomic in this zone's request).
        const m = methodFromLive(f, profile.currency);
        m.weightConditionsToCreate = [{ operator: "GREATER_THAN_OR_EQUAL_TO", criteria: { value: r1(topMax + 0.1), unit: "POUNDS" } }];
        fbDelete.push(f.id);
        fbCreate.push(m);
        console.log(`  zone ${z.name}: "${FALLBACK_RATE_NAME}" ($${f.price}, floor ${floor ?? "none"}) -> will be re-created with floor >= ${r1(topMax + 0.1)} lb`);
      } else {
        blockers.push(`zone ${z.name}: "${FALLBACK_RATE_NAME}" floor is ${floor ?? "none"} lb (must be > ${topMax} lb, else it shows alongside tiers). Pass --fix-fallback to re-create it with a ${r1(topMax + 0.1)} lb floor, or --allow-fallback-overlap`);
      }
    }
    const others = keep.filter((m) => !isFallback(m));
    console.log(`  ${describeZone(z)}: delete ${replace.length} old Standard/Express, create ${tiers.length * SERVICES.length}, keep fallback x${fb.length}${others.length ? `, ${others.length} other rates untouched (${others.map((o) => o.name).join(", ")})` : ""}${fb.length === 0 ? "  [no fallback rate in this zone]" : ""}`);
    work.push({
      zoneId: z.id,
      zoneName: z.name,
      deleteIds: [...replace.map((m) => m.id), ...fbDelete],
      create: [...SERVICES.flatMap((s) => tiers.map((t) => tierMethod(s.name, s.perUnit, t, profile.currency))), ...fbCreate],
    });
  }
  const overlapOnly = blockers.every((b) => b.includes("floor is"));
  const requests = planRequests(work);
  console.log(`requests: ${requests.length} (<= 5 zones each)`);
  if (blockers.length > 0) {
    console.log(`BLOCKERS:\n  - ${blockers.join("\n  - ")}`);
    if (!(flag("allow-fallback-overlap") && overlapOnly)) {
      if (execute) throw new Error("Refusing to write while blockers remain.");
    }
  }
  if (!execute) {
    console.log("DRY RUN — nothing written. Re-run with --execute.");
    return;
  }

  const bk = await ensureOriginalBackup(profile);
  console.log(bk.created ? `original rates recorded -> ${bk.path}` : `original backup already exists (kept) -> ${bk.path}`);

  for (let i = 0; i < requests.length; i++) {
    const r = requests[i];
    const res = await sendUpdate(profile, r);
    console.log(`request ${i + 1}/${requests.length} (${r.map((w) => w.zoneName).join(", ")}): ${res.ok ? "ok" : "FAILED " + JSON.stringify(res.errors)}`);
    if (!res.ok) throw new Error(`deliveryProfileUpdate failed on request ${i + 1}; stopping. Re-run to retry (idempotent) or --rollback --execute.`);
    await sleepMs(PACING_MS);
  }
  const after = await readGeneralProfile();
  const bad = verifyProfile(after);
  if (bad.length > 0) process.exitCode = 1;
}

// --- canary -------------------------------------------------------------------------

async function canary(zoneArg: string, execute: boolean) {
  const maxUnits = Number(arg("max-units") ?? MAX_UNITS);
  const profile = await readGeneralProfile();
  const zone = profile.zones.find((z) => zoneIdMatches(z, zoneArg));
  if (!zone) throw new Error(`zone ${zoneArg} not found. Zones:\n${profile.zones.map(describeZone).map((s) => "  " + s).join("\n")}`);
  console.log(`canary zone: ${describeZone(zone)}; ramp to ${maxUnits} units (2 canary rates per unit, named "${CANARY_PREFIX}Standard/Express Shipping")`);
  if (!execute) {
    console.log("DRY RUN — nothing written. The canary creates real rates in this zone for a few minutes and then deletes them; prefer a low-traffic zone. Re-run with --execute.");
    return;
  }
  const bk = await ensureOriginalBackup(profile);
  console.log(bk.created ? `original rates recorded -> ${bk.path}` : `original backup already exists (kept) -> ${bk.path}`);

  const before = zone.methods.length;
  let okUnits = 0;
  let rejection: string | null = null;
  const tryAdd = async (from: number, to: number) => {
    const create: MethodCreate[] = [];
    for (let n = from; n <= to; n++) for (const s of SERVICES) create.push(tierMethod(`${CANARY_PREFIX}${s.name}`, s.perUnit, exactTier(n), profile.currency));
    return sendUpdate(profile, [{ zoneId: zone.id, zoneName: zone.name, deleteIds: [], create }]);
  };

  try {
    while (okUnits < maxUnits && !rejection) {
      const to = Math.min(okUnits + CANARY_RAMP_UNITS, maxUnits);
      const res = await tryAdd(okUnits + 1, to);
      if (res.ok) {
        okUnits = to;
        console.log(`  ok through ${okUnits} units (${okUnits * 2} canary rates)`);
      } else {
        // The block was rejected as a unit (assumed atomic): re-probe one unit at a time to find the exact edge.
        console.log(`  block ${okUnits + 1}-${to} rejected: ${JSON.stringify(res.errors)} — probing singly`);
        const cur = (await readGeneralProfile()).zones.find((z) => z.id === zone.id)!;
        okUnits = cur.methods.filter((m) => isCanary(m.name) && m.name.includes("Standard")).length;
        for (let n = okUnits + 1; n <= to; n++) {
          const one = await tryAdd(n, n);
          if (!one.ok) {
            rejection = JSON.stringify(one.errors);
            break;
          }
          okUnits = n;
        }
        if (!rejection) rejection = `block rejected (${JSON.stringify(res.errors)}) but singles all passed`;
      }
      await sleepMs(PACING_MS);
    }
  } finally {
    const now = (await readGeneralProfile()).zones.find((z) => z.id === zone.id)!;
    const canaryRates = now.methods.filter((m) => isCanary(m.name));
    const totalAtPeak = now.methods.length;
    console.log(`peak: ${canaryRates.length} canary rates present, ${totalAtPeak} total rates in zone (${before} pre-existing)`);
    for (let i = 0; i < canaryRates.length; i += 100) {
      const res = await sendUpdate(profile, [{ zoneId: zone.id, zoneName: zone.name, deleteIds: canaryRates.slice(i, i + 100).map((m) => m.id), create: [] }]);
      if (!res.ok) console.error(`ROLLBACK ERROR: ${JSON.stringify(res.errors)} — run --rollback --execute`);
      await sleepMs(PACING_MS);
    }
    const after = (await readGeneralProfile()).zones.find((z) => z.id === zone.id)!;
    const clean = after.methods.length === before && after.methods.every((m) => zone.methods.some((o) => o.id === m.id));
    console.log(clean ? `canary rolled back: zone back to its ${before} original rates.` : `WARNING: zone has ${after.methods.length} rates, expected ${before} originals — run --rollback --execute.`);
  }

  const fullLadder = buildTiers().length * SERVICES.length;
  console.log(
    rejection
      ? `OBSERVED CAP: Shopify rejected after ${okUnits} units (${okUnits * 2} canary rates + ${before} pre-existing = ${okUnits * 2 + before} rates in zone). Error: ${rejection}`
      : `NO CAP HIT up to ${okUnits} units (${okUnits * 2} canary rates + ${before} pre-existing = ${okUnits * 2 + before} rates in zone).`,
  );
  console.log(`The full ladder needs ${fullLadder} rates/zone (+ kept rates).`);
  await logEvent({ event: "canary", zone: zone.id, okUnits, rejection, preExisting: before });
}

// --- rollback ---------------------------------------------------------------------------

async function rollback(execute: boolean) {
  const original = await readOriginalBackup();
  const profile = await readGeneralProfile();
  const work: ZoneWork[] = [];
  for (const z of profile.zones) {
    const orig = original.zones.find((o) => o.id === z.id);
    if (!orig) {
      console.log(`  zone ${z.name}: not in the backup — left alone`);
      continue;
    }
    const liveIds = new Set(z.methods.map((m) => m.id));
    const origIds = new Set(orig.methods.map((m) => m.id));
    const toDelete = z.methods.filter((m) => m.kind === "rate" && !origIds.has(m.id));
    const toRestore = orig.methods.filter((m) => m.kind === "rate" && !liveIds.has(m.id));
    const lostCarrier = orig.methods.filter((m) => m.kind === "participant" && !liveIds.has(m.id));
    console.log(`  ${z.name}: delete ${toDelete.length} added rates, restore ${toRestore.length} original rates${lostCarrier.length ? `, ${lostCarrier.length} carrier-calculated rates were removed outside this script and cannot be restored here` : ""}`);
    work.push({ zoneId: z.id, zoneName: z.name, deleteIds: toDelete.map((m) => m.id), create: toRestore.map((m) => methodFromLive(m, original.currency)) });
  }
  const requests = planRequests(work);
  if (!execute) {
    console.log(`DRY RUN — ${requests.length} requests. Re-run with --execute.`);
    return;
  }
  for (let i = 0; i < requests.length; i++) {
    const res = await sendUpdate(profile, requests[i]);
    console.log(`request ${i + 1}/${requests.length}: ${res.ok ? "ok" : "FAILED " + JSON.stringify(res.errors)}`);
    if (!res.ok) throw new Error("rollback request failed; stopping");
    await sleepMs(PACING_MS);
  }
  const after = await readGeneralProfile();
  let bad = 0;
  for (const z of after.zones) {
    const orig = original.zones.find((o) => o.id === z.id);
    if (!orig) continue;
    const sig = (m: { name: string; price: string | null }) => `${m.name}|${m.price === null ? "" : Number(m.price).toFixed(2)}`;
    const a = z.methods.map(sig).sort().join("\n");
    const b = orig.methods.map(sig).sort().join("\n");
    if (a !== b) {
      bad++;
      console.log(`  MISMATCH after rollback in ${z.name}`);
    }
  }
  console.log(bad === 0 ? "rollback verified: every zone's rates (name + price) match the recorded original." : `rollback left ${bad} zone(s) differing from the original.`);
  if (bad > 0) process.exitCode = 1;
}

async function main() {
  const execute = flag("execute");
  if (flag("rollback")) return rollback(execute);
  if (flag("canary")) {
    const zone = arg("zone");
    if (!zone) throw new Error("--canary needs --zone <zone id>. Run `npm run shipping:rates` (dry-run) to list zones.");
    return canary(zone, execute);
  }
  if (flag("verify")) {
    if (verifyProfile(await readGeneralProfile()).length > 0) process.exitCode = 1;
    return;
  }
  return fullRun(execute);
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
