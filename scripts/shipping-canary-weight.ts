/**
 * Omit-preserves canary: does a productSet that OMITS inventoryItem.measurement
 * leave an already-set 1 lb weight alone? Matters because reconcile/other
 * productSet callers might otherwise silently reset weights.
 *
 *   npm run shipping:canary-weight -- --styleCode X              # dry-run: shows the target draft
 *   npm run shipping:canary-weight -- --styleCode X --execute    # runs the test
 *
 * Writes ONE existing DRAFT product only (refuses anything not DRAFT or not
 * exactly matching the planned title). Existing per-variant prices are passed
 * back unchanged so the productSet doesn't touch them. Sequence:
 *   read -> productSet WITH weight -> read -> productSet WITHOUT weight -> read
 * If media links look disturbed afterwards, re-run `npm run drafts -- create
 * --styleCode X --resume` (re-attaches images) — only drafts are at risk here.
 */
import { fetchVariants, planDraft, variantKey, weightInLb } from "@/lib/shopify-draft";
import { setShopifyProductStructure } from "@/lib/shopify-reconcile";
import { CORE_WEIGHT_LB } from "@/lib/shipping-config";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const styleCode = arg("styleCode");
  if (!styleCode) throw new Error("--styleCode <draft style code> is required");
  const execute = process.argv.includes("--execute");

  const plan = await planDraft(styleCode);
  if (plan.existingOnShopify.length !== 1) throw new Error(`expected exactly one Shopify product for ${styleCode}, found ${plan.existingOnShopify.length}`);
  const [draft] = plan.existingOnShopify;
  if (draft.status !== "DRAFT") throw new Error(`${draft.id} is ${draft.status}, not DRAFT — refusing`);
  if (draft.title !== plan.title) throw new Error(`${draft.id} title "${draft.title}" != planned "${plan.title}" — refusing`);
  const numericId = Number(draft.id.split("/").pop());

  const snapshot = async (label: string) => {
    const vs = await fetchVariants(draft.id);
    const weights = new Map<string, number>();
    for (const v of vs) {
      const w = weightInLb(v.inventoryItem?.measurement.weight ?? null);
      weights.set(w === null ? "none" : String(w), (weights.get(w === null ? "none" : String(w)) ?? 0) + 1);
    }
    const shipping = vs.filter((v) => v.inventoryItem?.requiresShipping).length;
    const media = vs.filter((v) => v.media.nodes.length > 0).length;
    console.log(`[${label}] ${vs.length} variants; weights ${JSON.stringify(Object.fromEntries(weights))}; requiresShipping ${shipping}/${vs.length}; with media ${media}`);
    return { vs, atTarget: vs.every((v) => weightInLb(v.inventoryItem?.measurement.weight ?? null) === CORE_WEIGHT_LB) };
  };

  console.log(`target draft: ${draft.id} "${draft.title}" [${draft.status}]`);
  const before = await snapshot("before");
  if (!execute) {
    console.log("DRY RUN — nothing written. Re-run with --execute.");
    return;
  }

  // Pass back each variant's existing price so productSet doesn't alter it.
  const priceByKey = new Map(before.vs.map((v) => [variantKey(v), v.price]));
  const priceFor = (t: { colorCode: string; size: string }) => priceByKey.get(`${t.colorCode}::${t.size}`) ?? plan.price;

  await setShopifyProductStructure(numericId, plan.colorValues, plan.sizeValues, plan.target, plan.sizeOptionName, priceFor, true);
  const withWeight = await snapshot("after productSet WITH weight");
  if (!withWeight.atTarget) throw new Error("productSet with weight did NOT set 1 lb on every variant — canary invalid, stopping");

  await setShopifyProductStructure(numericId, plan.colorValues, plan.sizeValues, plan.target, plan.sizeOptionName, priceFor, false);
  const withoutWeight = await snapshot("after productSet WITHOUT weight");

  console.log(
    withoutWeight.atTarget
      ? "RESULT: omitting weight PRESERVES it (every variant still 1 lb)."
      : "RESULT: omitting weight does NOT preserve it — productSet without weight reset/changed weights. Any productSet caller must send weight.",
  );
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
