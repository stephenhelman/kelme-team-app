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
 *   npm run sizes -- add-sizes --styleCode X [--sizes XXS]      # step 4: add a newly sellable size to a LIVE product (read-only dry-run)
 *   npm run sizes -- add-sizes --styleCode X --execute
 *
 *   npm run sizes -- relabel-batch --limit 10 [--exclude A,B]    # step 5: next N pending kids styles (dry-run)
 *   npm run sizes -- relabel-batch --limit 10 --execute          # runs them one by one, verify each, stops on first failure
 *   npm run sizes -- rollback-batch --batchId ID [--execute]     # rename back every style in that batch
 *
 * Stop the Railway worker before any --execute (see the cutover runbook).
 */
import {
  RELABEL_LOG_PATH,
  kidsStyleCodes,
  planIsPending,
  styleBatchesOfLog,
  executeStyle,
  planProblems,
  planStyle,
  rollbackPlanText,
  rollbackStyle,
  valueInput,
  type StylePlan,
  type VerifyResult,
} from "@/lib/size-relabel";
import { executeAdd, planAdd } from "@/lib/size-add";
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

async function addSizes(execute: boolean) {
  const styleCode = arg("styleCode");
  if (!styleCode) throw new Error("--styleCode is required");
  const only = (arg("sizes") ?? "XXS").split(",");
  const plan = await planAdd(styleCode, only);
  console.log(`style ${styleCode} (pdtid ${plan.pdtid}) — sizes ${only.join(",")}`);
  if (plan.shopify) console.log(`Shopify: ${plan.shopify.title} [${plan.shopify.status}] ${plan.shopify.productGid}, ${plan.shopify.variants} variants`);
  console.log(`Price new variants will carry: ${plan.price ? plan.price.price : "(unresolved)"}${plan.price?.compareAtPrices.length ? ` (compare-at present: ${plan.price.compareAtPrices.join(",")} — NOT copied)` : ""}`);
  console.log(`DB already has ${plan.alreadyInDb} of these; to add: ${plan.newVariants.length}`);
  for (const n of plan.newVariants) console.log(`  + ${n.sku}  ${n.colorName}  qty ${n.qty}`);
  for (const p of plan.problems) console.log(`PROBLEM: ${p}`);
  if (plan.problems.length > 0) {
    console.log("STOPPED.");
    process.exitCode = 1;
    return;
  }
  if (!execute) {
    console.log("DRY RUN — nothing written (Kelme was only read). Re-run with --execute (worker stopped).");
    return;
  }
  console.log("EXECUTING: capture -> guard -> reconcile/order/media/tags -> relink -> inventory push -> verify");
  const res = await executeAdd(styleCode, only);
  for (const c of res.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  console.log(res.ok ? "ALL CHECKS PASSED." : "CHECKS FAILED — see above.");
  if (!res.ok) process.exitCode = 1;
}

async function relabelBatch(execute: boolean) {
  const limit = Number(arg("limit") ?? "10");
  const exclude = new Set((arg("exclude") ?? "").split(",").filter(Boolean));
  const all = (await kidsStyleCodes()).filter((s) => !exclude.has(s));
  console.log(`${all.length} kids styles on live products; scanning for pending work...`);
  const batch: { styleCode: string; plan: StylePlan }[] = [];
  let done = 0;
  for (const styleCode of all) {
    const plan = await planStyle(styleCode);
    const problems = planProblems(plan);
    if (problems.length > 0) {
      console.log(`PROBLEM ${styleCode}:\n  ${problems.join("\n  ")}`);
      process.exitCode = 1;
      if (execute) return console.log("STOPPED — resolve the problem (or pass --exclude) before executing.");
      continue;
    }
    if (!planIsPending(plan)) {
      done++;
      continue;
    }
    batch.push({ styleCode, plan });
    if (batch.length >= limit) break;
  }
  console.log(`already done: ${done}; this batch: ${batch.length} style(s)`);
  for (const b of batch) {
    const ops = b.plan.products.reduce((n, p) => n + p.ops.length, 0);
    const skus = b.plan.products.reduce((n, p) => n + p.skuWrites.length, 0);
    console.log(`  ${b.styleCode}: ${b.plan.products.length} product(s), ${ops} value rename(s), ${skus} SKU(s), ${b.plan.dbUpdates.length} DB row(s)`);
  }
  if (!execute) return console.log("DRY RUN — nothing written. Re-run with --execute (worker stopped).");
  const batchId = `kids-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`\nBATCH ID ${batchId}  (rollback: npm run sizes -- rollback-batch --batchId ${batchId} --execute)`);
  for (const b of batch) {
    console.log(`\n== ${b.styleCode}`);
    const res = await executeStyle(b.plan, batchId);
    for (const p of res.perProduct) printChecks(p.verify);
    if (!res.ok) {
      console.log(`\nVERIFY FAILED on ${b.styleCode} — STOPPING. Roll back this batch: npm run sizes -- rollback-batch --batchId ${batchId} --execute`);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\nBATCH ${batchId} OK (${batch.length} styles). Run the same command again for the next batch.`);
}

async function rollbackBatch(execute: boolean) {
  const batchId = arg("batchId");
  if (!batchId) throw new Error("--batchId is required");
  const styles = (await styleBatchesOfLog(batchId)).reverse();
  console.log(`batch ${batchId}: ${styles.length} style(s), rolled back in reverse order: ${styles.join(", ")}`);
  if (!execute) return console.log("DRY RUN — nothing written. Re-run with --execute.");
  for (const styleCode of styles) {
    console.log(`\n== rollback ${styleCode}`);
    const res = await rollbackStyle(styleCode);
    printChecks(res);
    if (!res.ok) {
      process.exitCode = 1;
      return console.log("ROLLBACK CHECK FAILED — stopping.");
    }
  }
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const execute = process.argv.includes("--execute");
  if (cmd === "seed") return seed(execute);
  if (cmd === "relabel") return relabel(execute);
  if (cmd === "rollback") return rollback(execute);
  if (cmd === "relabel-batch") return relabelBatch(execute);
  if (cmd === "rollback-batch") return rollbackBatch(execute);
  if (cmd === "add-sizes") return addSizes(execute);
  throw new Error(`unknown command "${cmd}" — expected: seed | relabel | rollback | relabel-batch | rollback-batch | add-sizes`);
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
