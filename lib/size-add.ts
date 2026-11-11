/**
 * Add newly sellable sizes (pass 1: XXS) to a LIVE product, end to end:
 *   Kelme re-capture (DB) -> reconcile (productSet, current price, 1 lb) ->
 *   size order -> relink -> inventory push -> verify.
 * Dry-run is strictly read-only: it reads Kelme's sheet in memory and compares
 * it with the DB; it never calls captureProduct.
 */
import { prisma } from "@/lib/prisma";
import { fetchSkuSheet } from "@/lib/kelme";
import { parseSkuSheet } from "@/lib/stock";
import { buildDeclaredVariants, captureProduct, isBallProduct, pullProductDeclaration } from "@/lib/kelme-capture";
import { buildSku } from "@/lib/sku";
import { dryRunBatch, executeBatch } from "@/lib/shopify-batch";
import { buildOptionValues, colorOptionValue, dryRunReconcile } from "@/lib/shopify-reconcile";
import { executeSizeOrder } from "@/lib/shopify-order";
import { executeMedia } from "@/lib/shopify-media";
import { addSizeOptionValues, appendAddLog, bulkCreateVariants, type BulkVariantSpec } from "@/lib/size-bulk";
import { executeRelink } from "@/lib/shopify-relink";
import { executePush } from "@/lib/shopify-inventory-push";
import { requireUniformPrice, type UniformPrice } from "@/lib/shopify-price";
import { fetchSnapshot, type Snapshot } from "@/lib/size-relabel";
import { shopifyGraphQL } from "@/lib/shopify";
import { CORE_WEIGHT_LB } from "@/lib/shipping-config";
import { CANONICAL_SIZE_ORDER } from "@/lib/sizes";

export interface AddPlan {
  styleCode: string;
  pdtid: number;
  newVariants: { colorCode: string; colorName: string; size: string; qty: number; sku: string }[];
  alreadyInDb: number;
  sizeGidMissing: string[];
  shopify: { productGid: string; title: string; status: string; variants: number } | null;
  price: UniformPrice | null;
  /** Variants the reconcile would add on Shopify right now (DB vs Shopify). */
  shopifyPendingAdds: number;
  problems: string[];
}

/** Read-only. `only` limits which sizes count as "new" (pass 1: ["XXS"]). */
export async function planAdd(styleCode: string, only: string[]): Promise<AddPlan> {
  const product = await prisma.product.findFirst({ where: { styleCode }, include: { variants: true } });
  if (!product) throw new Error(`no DB product ${styleCode}`);
  const plan: AddPlan = { styleCode, pdtid: product.pdtid, newVariants: [], alreadyInDb: 0, sizeGidMissing: [], shopify: null, price: null, shopifyPendingAdds: 0, problems: [] };

  const allowed = new Set((await prisma.size.findMany({ select: { shopifySize: true } })).map((s) => s.shopifySize));
  const sheet = await fetchSkuSheet(product.pdtid);
  const { entries } = parseSkuSheet(sheet, styleCode);
  const declared = buildDeclaredVariants(entries, isBallProduct(product.name), allowed);
  const have = new Set(product.variants.map((v) => `${v.colorCode}::${v.shopifySize}`));
  for (const d of declared) {
    if (!only.includes(d.shopifySize)) continue;
    if (have.has(`${d.colorCode}::${d.shopifySize}`)) plan.alreadyInDb++;
    else plan.newVariants.push({ colorCode: d.colorCode, colorName: d.colorName, size: d.shopifySize, qty: d.qty, sku: buildSku(styleCode, d.colorCode, d.shopifySize) });
  }
  // Allowed sizes only come from the Size table; a size Kelme offers that is not there yet shows up as missing.
  for (const s of only) {
    const row = await prisma.size.findUnique({ where: { shopifySize: s } });
    if (!row?.shopifyGid) plan.sizeGidMissing.push(s);
  }
  if (plan.sizeGidMissing.length > 0) plan.problems.push(`Size table has no Shopify GID for: ${plan.sizeGidMissing.join(", ")} — run \`npm run sizes -- seed --execute\``);
  if (plan.sizeGidMissing.length === 0 && plan.newVariants.length === 0 && plan.alreadyInDb === 0) plan.problems.push(`Kelme offers none of ${only.join("/")} for this product`);

  const linked = product.variants.find((v) => v.shopifyVariantId);
  if (!linked) {
    plan.problems.push("no DB variant is linked to Shopify");
    return plan;
  }
  const dry = await dryRunBatch(styleCode);
  if (dry.skipReason || dry.shopifyProductId === null) {
    plan.problems.push(`no unambiguous Shopify match: ${dry.skipReason ?? "unknown"}`);
    return plan;
  }
  plan.shopifyPendingAdds = dry.variantsToAdd.length;
  const productGid = `gid://shopify/Product/${dry.shopifyProductId}`;
  const snap = await fetchSnapshot(productGid);
  plan.shopify = { productGid, title: snap.title, status: snap.status, variants: snap.variants.length };
  try {
    plan.price = await requireUniformPrice(productGid);
  } catch (e) {
    plan.problems.push(e instanceof Error ? e.message : String(e)); // mixed prices stop the run and list the product
  }
  return plan;
}

export interface AddResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

async function productTags(productGid: string): Promise<string[]> {
  const res = await shopifyGraphQL<{ product: { tags: string[] } | null }>(`query($id:ID!){ product(id:$id){ tags } }`, { id: productGid });
  if (res.errors?.length || !res.data?.product) throw new Error(`tags query failed: ${JSON.stringify(res.errors ?? res)}`);
  return [...res.data.product.tags].sort();
}

export interface AddOptions {
  /** "set" = existing productSet reconcile (products that stay <= 100 variants); "bulk" = append-only productVariantsBulkCreate (live products past 100). */
  method?: "set" | "bulk";
  batchId?: string;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function executeAdd(styleCode: string, only: string[], opts: AddOptions = {}): Promise<AddResult> {
  const method = opts.method ?? "set";
  const batchId = opts.batchId ?? `single-${Date.now()}`;
  const plan = await planAdd(styleCode, only);
  if (plan.problems.length > 0) throw new Error(`refusing to execute:\n  ${plan.problems.join("\n  ")}`);
  const before = await fetchSnapshot(plan.shopify!.productGid);
  const tagsBefore = await productTags(plan.shopify!.productGid);

  // 1. Kelme -> DB (this is the first write).
  const cap = await captureProduct(plan.pdtid);
  if (!cap.ok) throw new Error(`capture failed: ${cap.error}`);
  await pullProductDeclaration(plan.pdtid, styleCode);

  // 2. Guard BEFORE any Shopify write: the reconcile must only add the requested sizes, delete nothing.
  const rec = await dryRunReconcile(styleCode);
  if (rec.toDelete.length > 0) throw new Error(`reconcile would DELETE ${rec.toDelete.length} variant(s) — stopped before any Shopify write`);
  const unexpected = rec.toAdd.filter((a) => !only.includes(a.size));
  if (unexpected.length > 0) throw new Error(`reconcile would add sizes outside ${only.join("/")}: ${[...new Set(unexpected.map((u) => u.size))].join(", ")} — stopped before any Shopify write`);

  // 3. Write. "set": reconcile (price + 1 lb enforced in lib), size order, media, tags.
  //    "bulk": append-only — add the missing linked Size values, productVariantsBulkCreate the new
  //    variants at the product's price / 1 lb, then size order + media. Created ids are logged first.
  // Written BEFORE any Shopify write: if the run dies midway, rollback still knows exactly which SKUs this batch may have created.
  await appendAddLog({ batchId, styleCode, productGid: plan.shopify!.productGid, kind: "planned", variants: plan.newVariants.map((n) => ({ id: "", sku: n.sku })), method });
  let batch: { overallOk: boolean; steps: unknown };
  if (method === "set") {
    batch = await executeBatch(styleCode);
  } else {
    if (rec.missingGids.length > 0) throw new Error(`target values missing shopifyGid: ${rec.missingGids.join("; ")}`);
    if (!before.sizeOption) throw new Error("product has no Size option — bulk add does not apply");
    const liveColors = new Set(before.variants.map((v) => v.color));
    const gidOf = new Map(rec.target.map((t) => [`${t.colorCode}::${t.size}`, t]));
    const specs: BulkVariantSpec[] = rec.toAdd.map((a) => {
      const t = gidOf.get(`${a.colorCode}::${a.size}`)!;
      const colorValue = colorOptionValue(a.colorName, a.colorCode);
      if (!liveColors.has(colorValue)) throw new Error(`color "${colorValue}" is not on the live product — bulk add never creates colors`);
      return { sku: buildSku(styleCode, a.colorCode, a.size), colorOptionValue: colorValue, colorGid: t.colorGid!, size: a.size, sizeGid: t.sizeGid!, price: plan.price!.price };
    });
    const { sizeValues } = buildOptionValues(rec.target);
    const wantedValues = sizeValues.filter((v) => specs.some((sp) => sp.size === v.name));
    const added = await addSizeOptionValues(plan.shopify!.productGid, before.sizeOption.id, before.sizeOption.values.map((v) => v.name), wantedValues);
    await appendAddLog({ batchId, styleCode, productGid: plan.shopify!.productGid, kind: "optionValuesAdded", values: added, method });
    await pause(400);
    const created = await bulkCreateVariants(plan.shopify!.productGid, specs, (made) =>
      appendAddLog({ batchId, styleCode, productGid: plan.shopify!.productGid, kind: "created", variants: made, method }),
    );
    await pause(400);
    const steps: Record<string, { ok: boolean; error?: string }> = { create: { ok: created.length === specs.length, error: `${created.length}/${specs.length}` } };
    for (const [name, fn] of [["sizeOrder", () => executeSizeOrder(Number(plan.shopify!.productGid.split("/").pop()))], ["media", () => executeMedia(Number(plan.shopify!.productGid.split("/").pop()))]] as const) {
      try {
        await fn();
        steps[name] = { ok: true };
      } catch (e) {
        steps[name] = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      await pause(400);
    }
    batch = { overallOk: Object.values(steps).every((x) => x.ok), steps };
  }
  // 4. Link new variant ids into the DB, then push Kelme inventory for this style.
  await executeRelink();
  const push = await executePush({ styleCode, cycleId: `size-add-${styleCode}-${Date.now()}` });

  // 5. Verify.
  const after = await fetchSnapshot(plan.shopify!.productGid);
  const checks: AddResult["checks"] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  add(method === "set" ? "batch steps (reconcile, size order, media, tags)" : "bulk steps (create, size order, media)", batch.overallOk, JSON.stringify(batch.steps));
  const beforeBy = new Map(before.variants.map((v) => [v.id, v]));
  const afterBy = new Map(after.variants.map((v) => [v.id, v]));
  const missing = before.variants.filter((v) => !afterBy.has(v.id));
  add("no existing variant lost (same ids)", missing.length === 0, `${missing.length} lost`);
  const changed = before.variants.filter((v) => {
    const a = afterBy.get(v.id);
    return a && (a.sku !== v.sku || a.price !== v.price || a.qty !== v.qty);
  });
  add("existing variants unchanged (sku, price)", changed.filter((v) => afterBy.get(v.id)!.sku !== v.sku || afterBy.get(v.id)!.price !== v.price).length === 0, `${changed.length} differ (qty may legitimately move with the push)`);
  const added = after.variants.filter((v) => !beforeBy.has(v.id));
  if (method === "set") await appendAddLog({ batchId, styleCode, productGid: plan.shopify!.productGid, kind: "created", variants: added.map((v) => ({ id: v.id, sku: v.sku })), method });
  add(`added ${plan.newVariants.length} ${only.join("/")} variants`, added.length === plan.newVariants.length, `${added.length} added`);
  add("new variants priced at the product's current price", added.every((v) => v.price === plan.price!.price), added.map((v) => v.price).join(","));
  add("new variants 1 lb + ships", added.every((v) => v.weightLb === CORE_WEIGHT_LB && v.requiresShipping === true), added.filter((v) => v.weightLb !== CORE_WEIGHT_LB).map((v) => v.sku).join(","));
  const wantSku = new Map(plan.newVariants.map((n) => [n.sku, n]));
  add("new variants carry the right SKUs", added.every((v) => wantSku.has(v.sku)), added.filter((v) => !wantSku.has(v.sku)).map((v) => v.sku).join(","));
  const wrongQty = added.filter((v) => (wantSku.get(v.sku)?.qty ?? -1) !== v.qty);
  add("new variants' inventory equals Kelme stock", wrongQty.length === 0, wrongQty.slice(0, 4).map((v) => `${v.sku}: ${v.qty} vs ${wantSku.get(v.sku)?.qty}`).join("; ") + ` (push ok=${push.ok ?? "?"})`);
  const sizeGidByName = new Map(rec.target.map((t) => [t.size, t.sizeGid]));
  const badLinks = [...new Set(plan.newVariants.map((n) => n.size))].filter((sz) => {
    const v = after.sizeOption?.values.find((x) => x.name === sz);
    return !v || v.linked !== sizeGidByName.get(sz);
  });
  add("new size option values are linked to the right Size metaobjects", badLinks.length === 0, badLinks.join(","));
  const tagsAfter = await productTags(plan.shopify!.productGid);
  add("product tags unchanged (core tag untouched)", JSON.stringify(tagsAfter) === JSON.stringify(tagsBefore), tagsBefore.join(",") === tagsAfter.join(",") ? "" : `${tagsBefore.join(",")} -> ${tagsAfter.join(",")}`);
  const dbRows = await prisma.variant.findMany({ where: { sku: { in: added.map((v) => v.sku) } }, select: { sku: true, shopifyVariantId: true } });
  const dbBy = new Map(dbRows.map((r) => [r.sku, r.shopifyVariantId]));
  const unlinked = added.filter((v) => dbBy.get(v.sku) !== v.id);
  add("DB rows linked to the new Shopify variant ids", unlinked.length === 0, unlinked.slice(0, 4).map((v) => v.sku).join(","));
  add("size option order", sizeOrderOk(after), (after.sizeOption?.values ?? []).map((v) => v.name).join(","));
  await appendAddLog({ batchId, styleCode, productGid: plan.shopify!.productGid, kind: "done", method });
  return { ok: checks.every((c) => c.ok), checks };
}

function sizeOrderOk(snap: Snapshot): boolean {
  const names = (snap.sizeOption?.values ?? []).map((v) => v.name);
  const rank = (n: string) => {
    const i = CANONICAL_SIZE_ORDER.indexOf(n);
    return i === -1 ? 999 : i;
  };
  return names.every((n, i) => i === 0 || rank(names[i - 1]) <= rank(n));
}

export interface AddRollbackPlan {
  batchId: string;
  products: { styleCode: string; productGid: string; variantIds: string[]; existing: string[]; skus: string[]; valuesAdded: string[] }[];
}

/** Rollback plan for one add batch: ONLY the variant ids that batch's log says it created. Never touches anything else. */
export async function planAddRollback(batchId: string): Promise<AddRollbackPlan> {
  const { readAddLog } = await import("@/lib/size-bulk");
  const log = (await readAddLog()).filter((e) => e.batchId === batchId);
  if (log.length === 0) throw new Error(`no entries for batch ${batchId} in size-add-log.jsonl`);
  if (log.some((e) => e.kind === "rolled-back")) throw new Error(`batch ${batchId} was already rolled back`);
  const byProduct = new Map<string, AddRollbackPlan["products"][number]>();
  for (const e of log) {
    const cur = byProduct.get(e.productGid) ?? { styleCode: e.styleCode, productGid: e.productGid, variantIds: [], existing: [], skus: [], valuesAdded: [] };
    if (e.kind === "created") for (const v of e.variants ?? []) { cur.variantIds.push(v.id); cur.skus.push(v.sku); }
    if (e.kind === "planned") for (const v of e.variants ?? []) { cur.skus.push(v.sku); cur.valuesAdded.push(v.sku.slice(v.sku.lastIndexOf("-") + 1)); }
    if (e.kind === "optionValuesAdded") cur.valuesAdded.push(...(e.values ?? []));
    byProduct.set(e.productGid, cur);
  }
  for (const p of byProduct.values()) {
    const snap = await fetchSnapshot(p.productGid);
    const live = new Map(snap.variants.map((v) => [v.id, v]));
    // created ids from the log, plus anything on Shopify now carrying a SKU this batch planned to create
    // (those SKUs did not exist before the batch, so they can only be this batch's variants).
    const planned = new Set(p.skus);
    const ids = new Set([...p.variantIds, ...snap.variants.filter((v) => planned.has(v.sku)).map((v) => v.id)]);
    p.variantIds = [...ids];
    p.valuesAdded = [...new Set(p.valuesAdded)]; // only dropped later if no remaining variant uses them
    p.existing = p.variantIds.filter((id) => live.has(id));
  }
  return { batchId, products: [...byProduct.values()] };
}

export async function executeAddRollback(plan: AddRollbackPlan): Promise<string[]> {
  const { bulkDeleteVariants, appendAddLog } = await import("@/lib/size-bulk");
  const out: string[] = [];
  for (const p of plan.products) {
    if (p.existing.length) await bulkDeleteVariants(p.productGid, p.existing);
    const deletedDb = await prisma.variant.deleteMany({ where: { shopifyVariantId: { in: p.variantIds } } });
    // Drop the Size option values this batch added, but only if no remaining variant uses them.
    const snap = await fetchSnapshot(p.productGid);
    const used = new Set(snap.variants.map((v) => v.size));
    const dropNames = p.valuesAdded.filter((n) => !used.has(n));
    const dropIds = (snap.sizeOption?.values ?? []).filter((v) => dropNames.includes(v.name)).map((v) => v.id);
    if (dropIds.length && snap.sizeOption) {
      const res = await shopifyGraphQL<{ productOptionUpdate: { userErrors: { message: string }[] } }>(
        `mutation($productId:ID!,$option:OptionUpdateInput!,$del:[ID!]){ productOptionUpdate(productId:$productId, option:$option, optionValuesToDelete:$del){ userErrors{ message } } }`,
        { productId: p.productGid, option: { id: snap.sizeOption.id }, del: dropIds },
      );
      const ue = res.data?.productOptionUpdate.userErrors ?? [];
      if (res.errors?.length || ue.length) out.push(`${p.styleCode}: could not drop option values ${dropNames.join(",")}: ${JSON.stringify(res.errors ?? ue)}`);
    }
    await appendAddLog({ batchId: plan.batchId, styleCode: p.styleCode, productGid: p.productGid, kind: "rolled-back", variants: p.existing.map((id) => ({ id, sku: "" })) });
    out.push(`${p.styleCode}: deleted ${p.existing.length} Shopify variant(s), ${deletedDb.count} DB row(s), dropped values ${dropNames.join(",") || "(none)"}`);
  }
  return out;
}
