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
import { dryRunReconcile } from "@/lib/shopify-reconcile";
import { executeRelink } from "@/lib/shopify-relink";
import { executePush } from "@/lib/shopify-inventory-push";
import { requireUniformPrice, type UniformPrice } from "@/lib/shopify-price";
import { fetchSnapshot, type Snapshot } from "@/lib/size-relabel";
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
  problems: string[];
}

/** Read-only. `only` limits which sizes count as "new" (pass 1: ["XXS"]). */
export async function planAdd(styleCode: string, only: string[]): Promise<AddPlan> {
  const product = await prisma.product.findFirst({ where: { styleCode }, include: { variants: true } });
  if (!product) throw new Error(`no DB product ${styleCode}`);
  const plan: AddPlan = { styleCode, pdtid: product.pdtid, newVariants: [], alreadyInDb: 0, sizeGidMissing: [], shopify: null, price: null, problems: [] };

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

export async function executeAdd(styleCode: string, only: string[]): Promise<AddResult> {
  const plan = await planAdd(styleCode, only);
  if (plan.problems.length > 0) throw new Error(`refusing to execute:\n  ${plan.problems.join("\n  ")}`);
  const before = await fetchSnapshot(plan.shopify!.productGid);

  // 1. Kelme -> DB (this is the first write).
  const cap = await captureProduct(plan.pdtid);
  if (!cap.ok) throw new Error(`capture failed: ${cap.error}`);
  await pullProductDeclaration(plan.pdtid, styleCode);

  // 2. Guard BEFORE any Shopify write: the reconcile must only add the requested sizes, delete nothing.
  const rec = await dryRunReconcile(styleCode);
  if (rec.toDelete.length > 0) throw new Error(`reconcile would DELETE ${rec.toDelete.length} variant(s) — stopped before any Shopify write`);
  const unexpected = rec.toAdd.filter((a) => !only.includes(a.size));
  if (unexpected.length > 0) throw new Error(`reconcile would add sizes outside ${only.join("/")}: ${[...new Set(unexpected.map((u) => u.size))].join(", ")} — stopped before any Shopify write`);

  // 3. Reconcile (price + 1 lb enforced in lib), size order, media, tags.
  const batch = await executeBatch(styleCode);
  // 4. Link new variant ids into the DB, then push Kelme inventory for this style.
  await executeRelink();
  const push = await executePush({ styleCode, cycleId: `size-add-${styleCode}-${Date.now()}` });

  // 5. Verify.
  const after = await fetchSnapshot(plan.shopify!.productGid);
  const checks: AddResult["checks"] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  add("batch steps (reconcile, size order, media, tags)", batch.overallOk, JSON.stringify(batch.steps));
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
  add(`added ${plan.newVariants.length} ${only.join("/")} variants`, added.length === plan.newVariants.length, `${added.length} added`);
  add("new variants priced at the product's current price", added.every((v) => v.price === plan.price!.price), added.map((v) => v.price).join(","));
  add("new variants 1 lb + ships", added.every((v) => v.weightLb === CORE_WEIGHT_LB && v.requiresShipping === true), added.filter((v) => v.weightLb !== CORE_WEIGHT_LB).map((v) => v.sku).join(","));
  const wantSku = new Map(plan.newVariants.map((n) => [n.sku, n]));
  add("new variants carry the right SKUs", added.every((v) => wantSku.has(v.sku)), added.filter((v) => !wantSku.has(v.sku)).map((v) => v.sku).join(","));
  const wrongQty = added.filter((v) => (wantSku.get(v.sku)?.qty ?? -1) !== v.qty);
  add("new variants' inventory equals Kelme stock", wrongQty.length === 0, wrongQty.slice(0, 4).map((v) => `${v.sku}: ${v.qty} vs ${wantSku.get(v.sku)?.qty}`).join("; ") + ` (push ok=${push.ok ?? "?"})`);
  add("size option order", sizeOrderOk(after), (after.sizeOption?.values ?? []).map((v) => v.name).join(","));
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
