/**
 * In-place kids relabel: rename the Size option VALUES on a live Shopify
 * product (and re-point each to the new size metaobject) so every variant keeps
 * its id, inventory, order history and DB link. Then restamp SKUs and move the
 * DB to the new labels.
 *
 *   old (Kelme cm -> label)        new
 *   110cm 4   120cm 6   130cm 8     110cm 2   120cm 4   130cm 6
 *   140cm 10  150cm 12  160cm 14    140cm 8   150cm 10  160cm 12
 *
 * Safety model:
 *   - plan (dry-run) is read-only and stops on anything unexpected;
 *   - the pre-change state (values, linked GIDs, SKUs, DB rows) is written to a
 *     JSONL log BEFORE the first write, so a rollback never depends on memory;
 *   - after every product a full verify compares ids/qty/weight/labels/SKUs/DB
 *     against the pre-change snapshot;
 *   - renames run in ascending order of NEW label, so each target label has
 *     just been freed ("4"->"2" first, then "6"->"4", ...).
 */
import { appendFile, readFile } from "fs/promises";
import path from "path";
import { prisma } from "@/lib/prisma";
import { shopifyGraphQL } from "@/lib/shopify";
import { buildSku } from "@/lib/sku";
import { KIDS_CM_TO_LABEL, formatSizeForVendor } from "@/lib/size-config";
import { CORE_WEIGHT_LB } from "@/lib/shipping-config";
import { weightInLb } from "@/lib/shopify-draft";

export const RELABEL_LOG_PATH = path.join(process.cwd(), "size-relabel-log.jsonl");
const PACING_MS = 400;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What the labels were before this change (Kelme cm -> old label). */
export const OLD_KIDS_CM_TO_LABEL: Record<string, string> = {
  "110cm": "4",
  "120cm": "6",
  "130cm": "8",
  "140cm": "10",
  "150cm": "12",
  "160cm": "14",
};

// ---------------------------------------------------------------- pure planning

export interface ValueGroup {
  valueId: string;
  name: string; // current option value name
  linked: string | null; // current linked metaobject GID
  cms: string[]; // distinct Kelme cm sizes of the variants carrying this value
  variantCount: number;
}

export interface RenameOp {
  valueId: string;
  cm: string;
  fromName: string;
  fromLinked: string | null;
  toName: string;
  toLinked: string;
}

export type RenameDecision = { ok: true; ops: RenameOp[]; alreadyDone: number } | { ok: false; problems: string[] };

/**
 * Decide which option values to rename. Pure. `sizeGid(label)` returns the
 * Size-table GID for a label (null = missing -> problem).
 */
export function decideRenames(groups: ValueGroup[], sizeGid: (label: string) => string | null): RenameDecision {
  const problems: string[] = [];
  const todo: RenameOp[] = [];
  let alreadyDone = 0;
  for (const g of groups) {
    if (g.cms.length !== 1) {
      problems.push(`value "${g.name}" carries variants of ${g.cms.length} different heights (${g.cms.join(", ") || "none"}) — cannot relabel unambiguously`);
      continue;
    }
    const cm = g.cms[0];
    const oldLabel = OLD_KIDS_CM_TO_LABEL[cm];
    const newLabel = KIDS_CM_TO_LABEL[cm];
    if (!oldLabel || !newLabel) {
      problems.push(`value "${g.name}" is ${cm}, which is not a mapped kids height`);
      continue;
    }
    if (g.name === newLabel) {
      alreadyDone++;
      continue;
    }
    if (g.name !== oldLabel) {
      problems.push(`value "${g.name}" for ${cm} is neither the old label "${oldLabel}" nor the new "${newLabel}"`);
      continue;
    }
    const toLinked = sizeGid(newLabel);
    if (!toLinked) {
      problems.push(`no Size-table GID for new label "${newLabel}" — run \`npm run sizes -- seed --execute\` first`);
      continue;
    }
    todo.push({ valueId: g.valueId, cm, fromName: g.name, fromLinked: g.linked, toName: newLabel, toLinked });
  }
  if (problems.length > 0) return { ok: false, problems };

  // Ascending by new label so each target has just been freed.
  todo.sort((a, b) => Number(a.toName) - Number(b.toName));
  const names = new Set(groups.map((g) => g.name));
  for (const op of todo) {
    if (names.has(op.toName)) {
      return { ok: false, problems: [`collision: renaming "${op.fromName}" -> "${op.toName}" but "${op.toName}" still exists on the option`] };
    }
    names.delete(op.fromName);
    names.add(op.toName);
  }
  return { ok: true, ops: todo, alreadyDone };
}

// ---------------------------------------------------------------- Shopify reads

export interface SnapVariant {
  id: string;
  sku: string;
  qty: number;
  color: string | null;
  size: string | null;
  inventoryItemId: string | null;
  weightLb: number | null;
  requiresShipping: boolean | null;
}
export interface Snapshot {
  productGid: string;
  title: string;
  status: string;
  sizeOption: { id: string; values: { id: string; name: string; linked: string | null }[] } | null;
  variants: SnapVariant[];
}

const SNAPSHOT_QUERY = `
  query relabelSnapshot($id: ID!, $cursor: String) {
    product(id: $id) {
      id title status
      options { id name optionValues { id name linkedMetafieldValue } }
      variants(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id sku inventoryQuantity
          selectedOptions { name value }
          inventoryItem { id requiresShipping measurement { weight { value unit } } }
        }
      }
    }
  }
`;

interface SnapshotResponse {
  product: {
    id: string;
    title: string;
    status: string;
    options: { id: string; name: string; optionValues: { id: string; name: string; linkedMetafieldValue: string | null }[] }[];
    variants: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        id: string;
        sku: string | null;
        inventoryQuantity: number | null;
        selectedOptions: { name: string; value: string }[];
        inventoryItem: { id: string; requiresShipping: boolean; measurement: { weight: { value: number; unit: string } | null } } | null;
      }[];
    };
  } | null;
}

export async function fetchSnapshot(productGid: string): Promise<Snapshot> {
  let base: NonNullable<SnapshotResponse["product"]> | null = null;
  const variants: SnapVariant[] = [];
  let cursor: string | null = null;
  for (;;) {
    const res: { data?: SnapshotResponse | null; errors?: unknown[] } = await shopifyGraphQL<SnapshotResponse>(SNAPSHOT_QUERY, { id: productGid, cursor });
    if (res.errors?.length) throw new Error(`snapshot query error: ${JSON.stringify(res.errors)}`);
    const p = res.data?.product;
    if (!p) throw new Error(`product ${productGid} not found`);
    base ??= p;
    for (const v of p.variants.nodes) {
      variants.push({
        id: v.id,
        sku: v.sku ?? "",
        qty: v.inventoryQuantity ?? 0,
        color: v.selectedOptions.find((o) => o.name === "Color")?.value ?? null,
        size: v.selectedOptions.find((o) => o.name === "Size")?.value ?? null,
        inventoryItemId: v.inventoryItem?.id ?? null,
        weightLb: weightInLb(v.inventoryItem?.measurement.weight ?? null),
        requiresShipping: v.inventoryItem?.requiresShipping ?? null,
      });
    }
    if (!p.variants.pageInfo.hasNextPage) break;
    cursor = p.variants.pageInfo.endCursor;
  }
  const opt = base!.options.find((o) => o.name === "Size");
  return {
    productGid,
    title: base!.title,
    status: base!.status,
    sizeOption: opt ? { id: opt.id, values: opt.optionValues.map((v) => ({ id: v.id, name: v.name, linked: v.linkedMetafieldValue })) } : null,
    variants,
  };
}

// ---------------------------------------------------------------- plan

export interface DbVariantRow {
  id: number;
  productId: number;
  colorCode: string;
  kelmeSize: string;
  shopifySize: string;
  sku: string;
  shopifyVariantId: string | null;
}

export interface ProductRelabelPlan {
  snapshot: Snapshot;
  ops: RenameOp[];
  alreadyDone: number;
  /** variant gid -> expected state after the relabel */
  expected: Map<string, { cm: string; newSize: string; newSku: string; oldSku: string; dbId: number }>;
  skuWrites: { id: string; sku: string }[];
  problems: string[];
}

export interface StylePlan {
  styleCode: string;
  products: ProductRelabelPlan[];
  dbUpdates: { dbId: number; productId: number; fromSize: string; toSize: string; fromSku: string; toSku: string }[];
  problems: string[];
}

async function productGidsForVariants(variantGids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < variantGids.length; i += 200) {
    const ids = variantGids.slice(i, i + 200);
    const res = await shopifyGraphQL<{ nodes: ({ id: string; product: { id: string } } | null)[] }>(
      `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant { id product { id } } } }`,
      { ids },
    );
    if (res.errors?.length) throw new Error(`variant->product query error: ${JSON.stringify(res.errors)}`);
    for (const n of res.data?.nodes ?? []) if (n) out.set(n.id, n.product.id);
  }
  return out;
}

export async function planStyle(styleCode: string, opts: { onlyProduct?: string } = {}): Promise<StylePlan> {
  const dbProduct = await prisma.product.findFirst({ where: { styleCode }, select: { id: true, name: true } });
  if (!dbProduct) return { styleCode, products: [], dbUpdates: [], problems: [`no DB product with styleCode ${styleCode}`] };
  const dbVariants = await prisma.variant.findMany({
    where: { productId: dbProduct.id },
    select: { id: true, productId: true, colorCode: true, kelmeSize: true, shopifySize: true, sku: true, shopifyVariantId: true },
  });
  const plan: StylePlan = { styleCode, products: [], dbUpdates: [], problems: [] };

  const linked = dbVariants.filter((v) => v.shopifyVariantId);
  const unlinked = dbVariants.filter((v) => !v.shopifyVariantId && v.kelmeSize.endsWith("cm"));
  if (unlinked.length > 0) plan.problems.push(`${unlinked.length} DB kids variant(s) have no shopifyVariantId (not on Shopify yet) — relabel only after they are created/linked, or they are DB-only and handled by the DB step`);
  if (linked.length === 0) {
    plan.problems.push("no DB variants linked to Shopify — nothing to relabel on Shopify");
    return plan;
  }

  const sizeRows = await prisma.size.findMany({ select: { shopifySize: true, shopifyGid: true } });
  const gidFor = (label: string) => sizeRows.find((s) => s.shopifySize === label)?.shopifyGid ?? null;

  const dbByVariantGid = new Map(linked.map((v) => [v.shopifyVariantId as string, v]));
  const productOf = await productGidsForVariants([...dbByVariantGid.keys()]);
  let productGids = [...new Set(productOf.values())];
  if (opts.onlyProduct) {
    if (!productGids.includes(opts.onlyProduct)) plan.problems.push(`--product ${opts.onlyProduct} is not one of this style's Shopify products (${productGids.join(", ")})`);
    productGids = productGids.filter((g) => g === opts.onlyProduct);
  }

  for (const productGid of productGids) {
    const snapshot = await fetchSnapshot(productGid);
    const pp: ProductRelabelPlan = { snapshot, ops: [], alreadyDone: 0, expected: new Map(), skuWrites: [], problems: [] };
    plan.products.push(pp);

    if (!snapshot.sizeOption) {
      pp.problems.push("product has no Size option");
      continue;
    }
    const groups = new Map<string, ValueGroup>();
    for (const sv of snapshot.sizeOption.values) groups.set(sv.name, { valueId: sv.id, name: sv.name, linked: sv.linked, cms: [], variantCount: 0 });

    for (const v of snapshot.variants) {
      const db = dbByVariantGid.get(v.id);
      if (!db) {
        pp.problems.push(`Shopify variant ${v.id} (${v.sku}) has no DB row`);
        continue;
      }
      if (!db.kelmeSize.endsWith("cm")) {
        pp.problems.push(`variant ${v.sku} is not a kids-height variant (kelmeSize "${db.kelmeSize}")`);
        continue;
      }
      const g = groups.get(v.size ?? "");
      if (!g) {
        pp.problems.push(`variant ${v.sku} has size "${v.size}" which is not a value of the Size option`);
        continue;
      }
      if (!g.cms.includes(db.kelmeSize)) g.cms.push(db.kelmeSize);
      g.variantCount++;
    }
    if (pp.problems.length > 0) continue;

    const used = [...groups.values()].filter((g) => g.variantCount > 0);
    const decision = decideRenames(used, gidFor);
    if (!decision.ok) {
      pp.problems.push(...decision.problems);
      continue;
    }
    pp.ops = decision.ops;
    pp.alreadyDone = decision.alreadyDone;

    for (const v of snapshot.variants) {
      const db = dbByVariantGid.get(v.id)!;
      const newSize = KIDS_CM_TO_LABEL[db.kelmeSize];
      const newSku = buildSku(styleCode, db.colorCode, newSize);
      pp.expected.set(v.id, { cm: db.kelmeSize, newSize, newSku, oldSku: v.sku, dbId: db.id });
      if (v.sku !== newSku) pp.skuWrites.push({ id: v.id, sku: newSku });
      if (db.shopifySize !== newSize || db.sku !== newSku) {
        plan.dbUpdates.push({ dbId: db.id, productId: db.productId, fromSize: db.shopifySize, toSize: newSize, fromSku: db.sku, toSku: newSku });
      }
    }
  }

  // DB-only kids variants (never linked) also move to the new labels.
  for (const v of unlinked) {
    const newSize = KIDS_CM_TO_LABEL[v.kelmeSize];
    if (!newSize) continue;
    const toSku = buildSku(styleCode, v.colorCode, newSize);
    if (v.shopifySize !== newSize || v.sku !== toSku) plan.dbUpdates.push({ dbId: v.id, productId: v.productId, fromSize: v.shopifySize, toSize: newSize, fromSku: v.sku, toSku });
  }
  return plan;
}

export function planProblems(plan: StylePlan): string[] {
  return [...plan.problems, ...plan.products.flatMap((p) => p.problems.map((x) => `${p.snapshot.title}: ${x}`))];
}

// ---------------------------------------------------------------- writes

const OPTION_UPDATE = `
  mutation relabelOptionValues($productId: ID!, $option: OptionUpdateInput!, $values: [OptionValueUpdateInput!]) {
    productOptionUpdate(productId: $productId, option: $option, optionValuesToUpdate: $values, variantStrategy: LEAVE_AS_IS) {
      product { id }
      userErrors { field message code }
    }
  }
`;

const BULK_SKU = `
  mutation relabelSkus($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) {
      productVariants { id sku }
      userErrors { field message code }
    }
  }
`;

type UserErrors = { field: string[] | null; message: string; code?: string }[];

async function logEvent(entry: Record<string, unknown>): Promise<void> {
  await appendFile(RELABEL_LOG_PATH, JSON.stringify({ ...entry, at: new Date().toISOString() }) + "\n");
}

export type ValueShape = "name+link" | "link-only";

export function valueInput(op: { valueId: string; toName: string; toLinked: string }, shape: ValueShape) {
  return shape === "name+link"
    ? { id: op.valueId, name: op.toName, linkedMetafieldValue: op.toLinked }
    : { id: op.valueId, linkedMetafieldValue: op.toLinked };
}

async function optionUpdate(productGid: string, optionId: string, values: ReturnType<typeof valueInput>[]): Promise<UserErrors> {
  const res = await shopifyGraphQL<{ productOptionUpdate: { userErrors: UserErrors } }>(OPTION_UPDATE, { productId: productGid, option: { id: optionId }, values });
  if (res.errors?.length) return [{ field: null, message: `GraphQL: ${JSON.stringify(res.errors)}` }];
  return res.data!.productOptionUpdate.userErrors;
}

async function writeSkus(productGid: string, writes: { id: string; sku: string }[]): Promise<void> {
  for (let i = 0; i < writes.length; i += 100) {
    const chunk = writes.slice(i, i + 100).map((w) => ({ id: w.id, inventoryItem: { sku: w.sku } }));
    const res = await shopifyGraphQL<{ productVariantsBulkUpdate: { userErrors: UserErrors } }>(BULK_SKU, { productId: productGid, variants: chunk });
    if (res.errors?.length) throw new Error(`SKU write GraphQL error: ${JSON.stringify(res.errors)}`);
    const errs = res.data!.productVariantsBulkUpdate.userErrors;
    if (errs.length > 0) throw new Error(`SKU write userErrors: ${JSON.stringify(errs)}`);
    await sleep(PACING_MS);
  }
}

/** Rename the option values: try one batched call, then one call per value; two payload shapes. Calls that fail change nothing. */
async function renameValues(productGid: string, styleCode: string, ops: RenameOp[]): Promise<{ shape: ValueShape; mode: "batch" | "sequential" }> {
  const snap0 = await fetchSnapshot(productGid);
  const optionId = snap0.sizeOption!.id;
  for (const shape of ["name+link", "link-only"] as ValueShape[]) {
    for (const mode of ["batch", "sequential"] as const) {
      const fresh = await fetchSnapshot(productGid);
      const remaining = ops.filter((op) => fresh.sizeOption!.values.find((v) => v.id === op.valueId)?.name !== op.toName);
      if (remaining.length === 0) return { shape, mode };
      const calls = mode === "batch" ? [remaining] : remaining.map((r) => [r]);
      let failed: UserErrors | null = null;
      for (const call of calls) {
        const errs = await optionUpdate(productGid, optionId, call.map((op) => valueInput(op, shape)));
        await logEvent({ kind: "option-update", styleCode, productGid, shape, mode, values: call.map((c) => `${c.fromName}->${c.toName}`), userErrors: errs });
        if (errs.length > 0) {
          failed = errs;
          break;
        }
        await sleep(PACING_MS);
      }
      const after = await fetchSnapshot(productGid);
      const left = ops.filter((op) => after.sizeOption!.values.find((v) => v.id === op.valueId)?.name !== op.toName);
      if (left.length === 0) return { shape, mode };
      if (!failed) throw new Error(`option update reported success but ${left.length} value(s) were not renamed`);
      console.log(`  attempt ${shape}/${mode} failed: ${failed.map((e) => e.message).join("; ")}`);
    }
  }
  throw new Error("all option-value rename attempts were refused by Shopify — nothing was changed; use the rebuild fallback or stop");
}

export interface VerifyResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

/** Compare the live state + DB with the pre-change snapshot and the plan. */
export async function verifyProduct(pp: ProductRelabelPlan, styleCode: string, opts: { db: boolean }): Promise<VerifyResult> {
  const before = pp.snapshot;
  const after = await fetchSnapshot(before.productGid);
  const checks: VerifyResult["checks"] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  const beforeIds = new Set(before.variants.map((v) => v.id));
  const afterIds = new Set(after.variants.map((v) => v.id));
  add("same variant ids", beforeIds.size === afterIds.size && [...beforeIds].every((i) => afterIds.has(i)), `${beforeIds.size} before / ${afterIds.size} after`);

  const afterBy = new Map(after.variants.map((v) => [v.id, v]));
  const badQty = before.variants.filter((v) => afterBy.get(v.id)?.qty !== v.qty);
  add("inventory unchanged", badQty.length === 0, badQty.slice(0, 3).map((v) => `${v.sku}: ${v.qty}->${afterBy.get(v.id)?.qty}`).join("; "));

  const badWeight = after.variants.filter((v) => v.weightLb !== CORE_WEIGHT_LB || v.requiresShipping !== true);
  const beforeBad = before.variants.filter((v) => v.weightLb !== CORE_WEIGHT_LB || v.requiresShipping !== true).length;
  add("weight still 1 lb + ships", badWeight.length <= beforeBad, `${badWeight.length} off target (${beforeBad} before)`);

  const badLabel = [...pp.expected].filter(([id, e]) => afterBy.get(id)?.size !== e.newSize);
  add("new labels on every variant", badLabel.length === 0, badLabel.slice(0, 3).map(([id, e]) => `${id}: ${afterBy.get(id)?.size} != ${e.newSize}`).join("; "));

  const badSku = [...pp.expected].filter(([id, e]) => afterBy.get(id)?.sku !== e.newSku);
  add("SKUs restamped", badSku.length === 0, badSku.slice(0, 3).map(([id, e]) => `${afterBy.get(id)?.sku} != ${e.newSku}`).join("; "));

  const valBy = new Map((after.sizeOption?.values ?? []).map((v) => [v.id, v]));
  const badLink = pp.ops.filter((op) => valBy.get(op.valueId)?.name !== op.toName || valBy.get(op.valueId)?.linked !== op.toLinked);
  add("option values keep ids and link to the new size values", badLink.length === 0, badLink.slice(0, 3).map((o) => `${o.fromName}->${o.toName}`).join("; "));

  if (opts.db) {
    const rows = await prisma.variant.findMany({ where: { id: { in: [...pp.expected.values()].map((e) => e.dbId) } }, select: { id: true, shopifyVariantId: true, shopifySize: true, sku: true, kelmeSize: true } });
    const rowBy = new Map(rows.map((r) => [r.shopifyVariantId, r]));
    const badDb = [...pp.expected].filter(([gid, e]) => {
      const r = rowBy.get(gid);
      return !r || r.shopifySize !== e.newSize || r.sku !== e.newSku;
    });
    add("DB rows relabeled and still linked to the same Shopify variant ids", badDb.length === 0, `${badDb.length} mismatched`);

    // Order/roster code resolves a line by SKU in the DB (lib/order-file-worker.ts loadVariantInfo).
    const bySku = await prisma.variant.findMany({
      where: { sku: { in: [...pp.expected.values()].map((e) => e.newSku) }, product: { styleCode } },
      select: { sku: true, shopifySize: true, kelmeSize: true },
    });
    const skuMap = new Map(bySku.map((r) => [r.sku, r]));
    const badOrder = [...pp.expected.values()].filter((e) => {
      const r = skuMap.get(e.newSku);
      return !r || r.shopifySize !== e.newSize || formatSizeForVendor(r.shopifySize, /cm$/i.test(r.kelmeSize)) !== `${e.newSize} (${e.cm})`;
    });
    add("order code resolves each new SKU to the right size ('6 (130cm)' style)", badOrder.length === 0, `${badOrder.length} unresolved`);
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export async function applyDbUpdates(styleCode: string, updates: StylePlan["dbUpdates"]): Promise<void> {
  // Ascending by new label inside one transaction so the unique key (product, color, size) is never violated mid-way.
  const sorted = [...updates].sort((a, b) => Number(a.toSize) - Number(b.toSize));
  await prisma.$transaction(async (tx) => {
    for (const u of sorted) await tx.variant.update({ where: { id: u.dbId }, data: { shopifySize: u.toSize, sku: u.toSku } });
    const productIds = [...new Set(sorted.map((u) => u.productId))];
    for (const pid of productIds) {
      const rows = await tx.variant.findMany({ where: { productId: pid }, select: { shopifySize: true } });
      await tx.product.update({ where: { id: pid }, data: { sizes: [...new Set(rows.map((r) => r.shopifySize))].sort() } });
    }
  });
  await logEvent({ kind: "db-updated", styleCode, count: updates.length });
}

export interface ExecuteStyleResult {
  styleCode: string;
  ok: boolean;
  perProduct: { productGid: string; title: string; verify: VerifyResult }[];
}

export async function executeStyle(plan: StylePlan): Promise<ExecuteStyleResult> {
  const problems = planProblems(plan);
  if (problems.length > 0) throw new Error(`refusing to execute — plan has problems:\n  ${problems.join("\n  ")}`);

  // 1. Pre-change state to the log BEFORE any write (rollback source).
  const sizesBefore = await prisma.product.findMany({ where: { styleCode: plan.styleCode }, select: { id: true, sizes: true } });
  await logEvent({
    kind: "relabel-start",
    styleCode: plan.styleCode,
    products: plan.products.map((p) => ({
      productGid: p.snapshot.productGid,
      optionId: p.snapshot.sizeOption!.id,
      ops: p.ops,
      before: { values: p.snapshot.sizeOption!.values, variants: p.snapshot.variants.map((v) => ({ id: v.id, sku: v.sku, size: v.size, qty: v.qty })) },
    })),
    db: { variants: plan.dbUpdates, productSizes: sizesBefore },
  });

  const perProduct: ExecuteStyleResult["perProduct"] = [];
  // 2. Shopify: rename values (ids kept), then SKUs.
  for (const pp of plan.products) {
    if (pp.ops.length > 0) {
      const used = await renameValues(pp.snapshot.productGid, plan.styleCode, pp.ops);
      console.log(`  ${pp.snapshot.title}: renamed ${pp.ops.length} value(s) (${used.shape}, ${used.mode})`);
    }
    if (pp.skuWrites.length > 0) {
      await writeSkus(pp.snapshot.productGid, pp.skuWrites);
      await logEvent({ kind: "skus-written", styleCode: plan.styleCode, productGid: pp.snapshot.productGid, count: pp.skuWrites.length });
      console.log(`  ${pp.snapshot.title}: restamped ${pp.skuWrites.length} SKU(s)`);
    }
  }
  // 3. DB.
  if (plan.dbUpdates.length > 0) await applyDbUpdates(plan.styleCode, plan.dbUpdates);
  // 4. Verify everything against the pre-change snapshot.
  for (const pp of plan.products) {
    const verify = await verifyProduct(pp, plan.styleCode, { db: true });
    perProduct.push({ productGid: pp.snapshot.productGid, title: pp.snapshot.title, verify });
    await logEvent({ kind: "verify", styleCode: plan.styleCode, productGid: pp.snapshot.productGid, ok: verify.ok, checks: verify.checks });
  }
  return { styleCode: plan.styleCode, ok: perProduct.every((p) => p.verify.ok), perProduct };
}

// ---------------------------------------------------------------- rollback

interface StartEntry {
  kind: "relabel-start";
  styleCode: string;
  products: { productGid: string; optionId: string; ops: RenameOp[]; before: { values: { id: string; name: string; linked: string | null }[]; variants: { id: string; sku: string }[] } }[];
  db: { variants: StylePlan["dbUpdates"]; productSizes: { id: number; sizes: string[] }[] };
}

export async function lastStart(styleCode: string): Promise<StartEntry | null> {
  let raw = "";
  try {
    raw = await readFile(RELABEL_LOG_PATH, "utf8");
  } catch {
    return null;
  }
  let found: StartEntry | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.kind === "relabel-start" && e.styleCode === styleCode) found = e as StartEntry;
  }
  return found;
}

export async function rollbackPlanText(styleCode: string): Promise<string[]> {
  const start = await lastStart(styleCode);
  if (!start) return [`no relabel-start entry for ${styleCode} in ${RELABEL_LOG_PATH}`];
  const out: string[] = [];
  for (const p of start.products) {
    const ops = [...p.ops].sort((a, b) => Number(b.fromName) - Number(a.fromName));
    out.push(`${p.productGid}: rename back ${ops.map((o) => `${o.toName}->${o.fromName}`).join(", ") || "(none)"}; restore ${p.before.variants.length} SKU(s)`);
  }
  out.push(`DB: restore ${start.db.variants.length} variant row(s) and Product.sizes for ${start.db.productSizes.length} product(s)`);
  return out;
}

export async function rollbackStyle(styleCode: string): Promise<VerifyResult> {
  const start = await lastStart(styleCode);
  if (!start) throw new Error(`no relabel-start entry for ${styleCode}`);
  const checks: VerifyResult["checks"] = [];
  for (const p of start.products) {
    // Descending by OLD label: the highest old label's name was freed first.
    const ops = [...p.ops].sort((a, b) => Number(b.fromName) - Number(a.fromName));
    for (const shape of ["name+link", "link-only"] as ValueShape[]) {
      const cur = await fetchSnapshot(p.productGid);
      const left = ops.filter((o) => cur.sizeOption!.values.find((v) => v.id === o.valueId)?.name !== o.fromName);
      if (left.length === 0) break;
      for (const o of left) {
        if (!o.fromLinked) throw new Error(`no original link recorded for ${o.fromName}`);
        const errs = await optionUpdate(p.productGid, p.optionId, [valueInput({ valueId: o.valueId, toName: o.fromName, toLinked: o.fromLinked }, shape)]);
        await logEvent({ kind: "rollback-option-update", styleCode, productGid: p.productGid, shape, value: `${o.toName}->${o.fromName}`, userErrors: errs });
        if (errs.length > 0) break;
        await sleep(PACING_MS);
      }
    }
    const after = await fetchSnapshot(p.productGid);
    const stillWrong = ops.filter((o) => after.sizeOption!.values.find((v) => v.id === o.valueId)?.name !== o.fromName);
    checks.push({ name: `${p.productGid}: option values restored`, ok: stillWrong.length === 0, detail: stillWrong.map((o) => o.fromName).join(",") });
    const skuBack = p.before.variants.filter((v) => after.variants.find((a) => a.id === v.id)?.sku !== v.sku).map((v) => ({ id: v.id, sku: v.sku }));
    if (skuBack.length > 0) await writeSkus(p.productGid, skuBack);
    const final = await fetchSnapshot(p.productGid);
    const badSku = p.before.variants.filter((v) => final.variants.find((a) => a.id === v.id)?.sku !== v.sku);
    checks.push({ name: `${p.productGid}: SKUs restored`, ok: badSku.length === 0, detail: `${badSku.length} wrong` });
  }
  // DB back to the logged state (descending new label so the unique key holds).
  const rows = [...start.db.variants].sort((a, b) => Number(b.fromSize) - Number(a.fromSize));
  await prisma.$transaction(async (tx) => {
    for (const u of rows) await tx.variant.update({ where: { id: u.dbId }, data: { shopifySize: u.fromSize, sku: u.fromSku } });
    for (const ps of start.db.productSizes) await tx.product.update({ where: { id: ps.id }, data: { sizes: ps.sizes } });
  });
  checks.push({ name: "DB restored", ok: true, detail: `${rows.length} rows` });
  await logEvent({ kind: "rollback-done", styleCode, checks });
  return { ok: checks.every((c) => c.ok), checks };
}
