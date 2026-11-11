/**
 * Size standardization tooling. DRY-RUN by default — nothing writes without --execute.
 *
 *   npm run sizes -- seed                 # step 2: show size metaobjects to create + Size-table rows
 *   npm run sizes -- seed --execute       # create "2"/"XXS" (if missing) and store GIDs in the Size table
 *
 *   npm run sizes -- relabel --styleCode X [--product gid://shopify/Product/N]
 *                                         # step 3: show the in-place kids relabel for one style
 *   npm run sizes -- relabel --styleCode X --execute
 *   npm run sizes -- rollback --styleCode X [--execute]   # rename back from the log
 *
 * Stop the Railway worker before any --execute (see the cutover runbook).
 */
import {
  RELABEL_LOG_PATH,
  executeStyle,
  planProblems,
  planStyle,
  rollbackPlanText,
  rollbackStyle,
  valueInput,
  type StylePlan,
  type VerifyResult,
} from "@/lib/size-relabel";
import { createVariables, executeSeed, planSeed } from "@/lib/size-seed";

async function seed(execute: boolean) {
  const plan = await planSeed();
  console.log("label  kind   shopify-metaobject                       size-table-gid                          action");
  for (const r of plan.rows) {
    console.log(`${r.label.padEnd(6)} ${r.kind.padEnd(6)} ${(r.existingGid ?? "(missing)").padEnd(40)} ${(r.tableGid ?? "(none)").padEnd(40)} ${r.action}`);
  }
  for (const c of plan.creates) {
    console.log(`\nWOULD CREATE metaobject "${c.label}":\n${JSON.stringify(createVariables(c), null, 2)}`);
  }
  const todo = plan.rows.filter((r) => r.action !== "none").length;
  console.log(`\n${plan.creates.length} metaobject(s) to create, ${todo} Size-table row(s) to write.`);
  if (!execute) {
    console.log("DRY RUN — nothing written. Re-run with --execute.");
    return;
  }
  const done = await executeSeed(plan);
  for (const d of done) console.log(`${d.created ? "created" : "reused "} ${d.label} -> ${d.gid} (stored in Size table)`);
  console.log("Done. The existing '14' Size row is left in place until the kids relabel finishes.");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function printChecks(v: VerifyResult) {
  for (const c of v.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
}

function printPlan(plan: StylePlan) {
  console.log(`style ${plan.styleCode}: ${plan.products.length} Shopify product(s)`);
  for (const pp of plan.products) {
    const snap = pp.snapshot;
    console.log(`\n${snap.title}  [${snap.status}]  ${snap.productGid}`);
    console.log(`  variants ${snap.variants.length}, total inventory ${snap.variants.reduce((n, v) => n + v.qty, 0)}, already-new values ${pp.alreadyDone}`);
    for (const op of pp.ops) console.log(`  rename value ${op.valueId.split("/").pop()}: "${op.fromName}" -> "${op.toName}"  (${op.cm})  link ${op.fromLinked ?? "none"} -> ${op.toLinked}`);
    for (const w of pp.skuWrites.slice(0, 4)) console.log(`  sku ${pp.expected.get(w.id)!.oldSku} -> ${w.sku}`);
    if (pp.skuWrites.length > 4) console.log(`  ... ${pp.skuWrites.length} SKU(s) in total`);
    if (pp.ops.length > 0) {
      console.log("  mutation (batched first; falls back to one value per call, then to link-only):");
      console.log(JSON.stringify({ productOptionUpdate: { productId: snap.productGid, option: { id: snap.sizeOption!.id }, optionValuesToUpdate: pp.ops.map((o) => valueInput(o, "name+link")), variantStrategy: "LEAVE_AS_IS" } }, null, 2).replace(/^/gm, "    "));
    }
  }
  console.log(`\nDB: ${plan.dbUpdates.length} variant row(s) to relabel + new SKU`);
  const problems = planProblems(plan);
  for (const p of problems) console.log(`PROBLEM: ${p}`);
}

async function relabel(execute: boolean) {
  const styleCode = arg("styleCode");
  if (!styleCode) throw new Error("--styleCode is required");
  const plan = await planStyle(styleCode, { onlyProduct: arg("product") });
  printPlan(plan);
  if (planProblems(plan).length > 0) {
    console.log("\nSTOPPED — fix the problems above.");
    process.exitCode = 1;
    return;
  }
  if (!execute) {
    console.log("\nDRY RUN — nothing written. Re-run with --execute (worker stopped).");
    return;
  }
  console.log("\nEXECUTING (pre-change state is logged first)...");
  const res = await executeStyle(plan);
  for (const p of res.perProduct) {
    console.log(`\nVERIFY ${p.title}`);
    printChecks(p.verify);
  }
  console.log(res.ok ? "\nALL CHECKS PASSED." : `\nCHECKS FAILED — roll back with: npm run sizes -- rollback --styleCode ${styleCode} --execute`);
  console.log(`Log: ${RELABEL_LOG_PATH}`);
  if (!res.ok) process.exitCode = 1;
}

async function rollback(execute: boolean) {
  const styleCode = arg("styleCode");
  if (!styleCode) throw new Error("--styleCode is required");
  for (const line of await rollbackPlanText(styleCode)) console.log(line);
  if (!execute) {
    console.log("DRY RUN — nothing written. Re-run with --execute.");
    return;
  }
  const res = await rollbackStyle(styleCode);
  printChecks(res);
  if (!res.ok) process.exitCode = 1;
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const execute = process.argv.includes("--execute");
  if (cmd === "seed") return seed(execute);
  if (cmd === "relabel") return relabel(execute);
  if (cmd === "rollback") return rollback(execute);
  throw new Error(`unknown command "${cmd}" — expected: seed | relabel | rollback`);
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
