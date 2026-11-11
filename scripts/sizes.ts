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
 *   npm run sizes -- add-sizes --styleCodes A,B,C [--execute]       # several styles, in order, stopping at the first problem
 *
 *   npm run sizes -- add-sizes --styleCode X --sizes 4XL,5XL,6XL,7XL [--method set|bulk]   # pass 2; bulk = append-only, required for live products past 100 variants
 *   npm run sizes -- add-sizes-batch --limit 10 [--exclude A,B] [--execute]       # pass 2: next N styles, verify each, stop on first failure
 *   npm run sizes -- add-sizes-rollback --batchId ID [--execute]                  # delete ONLY the variants that batch created (bulk method)
 *   npm run sizes -- extended-report [--styleCodes A,B]           # pass 2: read-only impact of 4XL-7XL on live products (writes extended-sizes-report.md)
 *
 *   npm run sizes -- relabel-batch --limit 10 [--exclude A,B]    # step 5: next N pending kids styles (dry-run)
 *   npm run sizes -- relabel-batch --limit 10 --execute          # runs them one by one, verify each, stops on first failure
 *   npm run sizes -- rollback-batch --batchId ID [--execute]     # rename back every style in that batch
 *
 *   npm run sizes -- status [--batchId ID | --all]               # read-only: complete / shopify-only / shopify-partial / untouched / anomaly per style
 *   npm run sizes -- post-check                                   # step 5 end: read-only DB<->Shopify link + inventory dry-run summary
 *   npm run sizes -- drop-old-sizes [--execute]                   # remove Size rows no longer sold (14, 16, 2XS) once no variant uses them
 *
 * Stop the Railway worker before any --execute (see the cutover runbook).
 */
import {
  RELABEL_LOG_PATH,
  classifyState,
  logStyles,
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
import { executeAdd, executeAddRollback, planAdd, planAddRollback } from "@/lib/size-add";
import { VARIANT_CAP } from "@/lib/size-extended";
import { ADULT_EXTENDED } from "@/lib/size-config";
import { dryRunRelink } from "@/lib/shopify-relink";
import { dryRunPush } from "@/lib/shopify-inventory-push";
import { prisma } from "@/lib/prisma";
import { sellableApparelLabels } from "@/lib/size-config";
import { createVariables, executeSeed, planSeed } from "@/lib/size-seed";
import { liveStyleCodes, planExtended, reportMarkdown, type ExtendedRow } from "@/lib/size-extended";
import { writeFileSync } from "node:fs";

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
  const st = classifyState(plan);
  console.log(`style ${plan.styleCode}: ${plan.products.length} Shopify product(s) — STATE ${st.state}: ${st.detail}`);
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
  const many = arg("styleCodes");
  if (many) {
    // Several styles in one go: each is planned and, with --execute, run and verified in turn; stops on the first problem or failed check.
    for (const code of many.split(",").map((x) => x.trim()).filter(Boolean)) {
      console.log(`\n===== ${code}`);
      await addSizesOne(code, execute);
      if (process.exitCode) return console.log(`\nSTOPPED at ${code} — fix it before continuing with the rest.`);
    }
    return;
  }
  const styleCode = arg("styleCode");
  if (!styleCode) throw new Error("--styleCode or --styleCodes is required");
  return addSizesOne(styleCode, execute);
}

async function addSizesOne(styleCode: string, execute: boolean) {
  const only = (arg("sizes") ?? "XXS").split(",");
  const method = (arg("method") ?? "set") as "set" | "bulk";
  if (method !== "set" && method !== "bulk") throw new Error("--method must be set or bulk");
  const plan = await planAdd(styleCode, only);
  if (method === "set" && plan.shopify && plan.shopify.variants + plan.newVariants.length > VARIANT_CAP) {
    plan.problems.push(`product would have ${plan.shopify.variants + plan.newVariants.length} variants (> ${VARIANT_CAP}); live products past ${VARIANT_CAP} are only extended with --method bulk (productVariantsBulkCreate), never productSet`);
  }
  console.log(`style ${styleCode} (pdtid ${plan.pdtid}) — sizes ${only.join(",")}`);
  if (plan.shopify) console.log(`Shopify: ${plan.shopify.title} [${plan.shopify.status}] ${plan.shopify.productGid}, ${plan.shopify.variants} variants`);
  console.log(`Price new variants will carry: ${plan.price ? plan.price.price : "(unresolved)"}${plan.price?.compareAtPrices.length ? ` (compare-at present: ${plan.price.compareAtPrices.join(",")} — NOT copied)` : ""}`);
  console.log(`DB already has ${plan.alreadyInDb} of these; to add: ${plan.newVariants.length}`);
  for (const n of plan.newVariants) console.log(`  + ${n.sku}  ${n.colorName}  qty ${n.qty}`);
  console.log(`Shopify is missing ${plan.shopifyPendingAdds} variant(s) vs the DB right now.`);
  for (const p of plan.problems) console.log(`PROBLEM: ${p}`);
  if (plan.problems.length === 0 && plan.newVariants.length === 0 && plan.shopifyPendingAdds === 0 && plan.alreadyInDb > 0) {
    console.log(`ALREADY DONE — ${only.join("/")} is in the DB and on Shopify; nothing to do for this style.`);
    return;
  }
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
  const batchId = arg("batchId") ?? `add-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`method ${method}, BATCH ID ${batchId}${method === "bulk" ? `  (rollback: npm run sizes -- add-sizes-rollback --batchId ${batchId} --execute)` : ""}`);
  const res = await executeAdd(styleCode, only, { method, batchId });
  for (const c of res.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  console.log(res.ok ? "ALL CHECKS PASSED." : "CHECKS FAILED — see above.");
  if (!res.ok) process.exitCode = 1;
}

async function addSizesBatch(execute: boolean) {
  const limit = Number(arg("limit") ?? "10");
  const exclude = new Set((arg("exclude") ?? "").split(",").filter(Boolean));
  const only = (arg("sizes") ?? ADULT_EXTENDED.join(",")).split(",");
  const styles = (await liveStyleCodes()).filter((s) => !exclude.has(s));
  console.log(`${styles.length} live styles; scanning for pending ${only.join("/")} work (products that would pass ${VARIANT_CAP} variants are skipped — they need --method bulk one at a time)...`);
  const batch: ExtendedRow[] = [];
  let done = 0, overCap = 0;
  for (const styleCode of styles) {
    const row = await planExtended(styleCode);
    if (!row) continue;
    if (row.problems.some((p) => !p.startsWith("extended sizes exist in color"))) {
      console.log(`PROBLEM ${styleCode}: ${row.problems.join("; ")}`);
      process.exitCode = 1;
      if (execute) return console.log("STOPPED — resolve the problem (or pass --exclude) before executing.");
      continue;
    }
    if (row.newVariants.length === 0) { done++; continue; }
    if (row.overCap) { overCap++; continue; }
    batch.push(row);
    if (batch.length >= limit) break;
  }
  console.log(`already done: ${done}; skipped over the cap: ${overCap}; this batch: ${batch.length} style(s), ${batch.reduce((n, r) => n + r.newVariants.length, 0)} variant(s)`);
  for (const r of batch) console.log(`  ${r.styleCode}: +${r.newVariants.length} (${r.currentVariants} -> ${r.afterCount}) @ ${r.prices.join("/")}  ${r.title.slice(0, 50)}`);
  if (!execute) return console.log("DRY RUN — nothing written. Re-run with --execute (worker stopped).");
  const batchId = `ext-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  console.log(`\nBATCH ID ${batchId}  (rollback: npm run sizes -- add-sizes-rollback --batchId ${batchId} --execute)`);
  for (const r of batch) {
    console.log(`\n===== ${r.styleCode}`);
    try {
      const res = await executeAdd(r.styleCode, only, { method: "set", batchId });
      for (const c of res.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
      if (!res.ok) { process.exitCode = 1; return console.log(`\nSTOPPED at ${r.styleCode} (checks failed). Batch ${batchId}.`); }
    } catch (e) {
      process.exitCode = 1;
      return console.log(`\nSTOPPED at ${r.styleCode}: ${e instanceof Error ? e.message : e}. Batch ${batchId}.`);
    }
  }
  console.log(`\nBATCH ${batchId} COMPLETE — ${batch.length} style(s) verified.`);
}

async function addSizesRollback(execute: boolean) {
  const batchId = arg("batchId");
  if (!batchId) throw new Error("--batchId is required");
  const plan = await planAddRollback(batchId);
  for (const p of plan.products) console.log(`${p.styleCode}: created ${p.variantIds.length}, still on Shopify ${p.existing.length}, option values added ${p.valuesAdded.join(",") || "(none)"}`);
  if (!execute) return console.log("DRY RUN — nothing written. Deletes ONLY the variants listed in the log for this batch. Re-run with --execute.");
  for (const line of await executeAddRollback(plan)) console.log(line);
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

async function postCheck() {
  const relink = await dryRunRelink();
  console.log(`DB variants ${relink.totalDbVariants}, matched to Shopify ${relink.matchedCount}, ambiguous ${relink.ambiguousMatchCount}`);
  console.log(`DB variants with no Shopify match: ${relink.dbUnmatched.length}; Shopify variants with no DB match: ${relink.shopifyUnmatched.length}; real link failures: ${relink.realLinkFailures.length}`);
  for (const u of relink.dbUnmatched.slice(0, 15)) console.log(`  db-unmatched ${JSON.stringify(u)}`);
  for (const u of relink.shopifyUnmatched.slice(0, 15)) console.log(`  shopify-unmatched ${JSON.stringify(u)}`);
  const push = await dryRunPush();
  console.log(`inventory push: ${push.totalOnShopifyVariants} linked variants, already correct ${push.alreadyCorrect}, would push ${push.toPush.length}, suspicious drops ${push.suspiciousDrops.length}, tracking disabled ${push.trackingDisabledCount}, null inventory item ${push.nullInventoryItemId.length}`);
  for (const c of push.toPush.slice(0, 15)) console.log(`  push ${c.sku}: ${c.currentOnHand} -> ${c.targetQty}`);
  const oldLabels = await prisma.variant.count({ where: { shopifySize: { in: ["14", "16", "2XS"] }, kelmeSize: { not: { in: ["5", "4", "3", "1"] } } } });
  console.log(`DB variants still on retired labels 14/16/2XS: ${oldLabels} (expect 0)`);
  console.log("EXPECTED after a clean cutover: unmatched 0 on both sides, real link failures 0, retired labels 0, and push candidates only where Kelme stock moved since the cutover.");
}

async function dropOldSizes(execute: boolean) {
  const keep = new Set([...sellableApparelLabels(), "One Size", "1", "3", "4", "5"]);
  const rows = await prisma.size.findMany();
  const stale = rows.filter((r) => !keep.has(r.shopifySize));
  for (const r of stale) {
    const used = await prisma.variant.count({ where: { shopifySize: r.shopifySize } });
    console.log(`Size row "${r.shopifySize}" (${r.kind}): ${used} DB variant(s) still use it${used > 0 ? " — NOT safe to drop" : ""}`);
  }
  if (stale.length === 0) return console.log("nothing to drop");
  if (!execute) return console.log("DRY RUN — nothing written. Re-run with --execute.");
  const safe = [];
  for (const r of stale) if ((await prisma.variant.count({ where: { shopifySize: r.shopifySize } })) === 0) safe.push(r.shopifySize);
  await prisma.size.deleteMany({ where: { shopifySize: { in: safe } } });
  console.log(`dropped: ${safe.join(", ") || "(none)"}`);
}

async function status() {
  const all = process.argv.includes("--all");
  const batchId = arg("batchId");
  const styles = all ? await kidsStyleCodes() : await logStyles(batchId);
  console.log(`${styles.length} style(s) ${all ? "(all kids styles)" : batchId ? `in batch ${batchId}` : "in the relabel log"}\n`);
  const counts: Record<string, string[]> = {};
  for (const styleCode of styles) {
    const plan = await planStyle(styleCode);
    const st = classifyState(plan);
    (counts[st.state] ??= []).push(styleCode);
    const probs = plan.problems.concat(plan.products.flatMap((p) => p.problems));
    console.log(`${styleCode.padEnd(14)} ${st.state.padEnd(16)} ${st.detail}${probs.length ? `  PROBLEMS: ${probs.join(" | ")}` : ""}`);
  }
  console.log("\nSUMMARY");
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v.length}${k === "complete" ? "" : `  -> ${v.join(", ")}`}`);
}

async function extendedReport() {
  const only = arg("styleCodes")?.split(",").map((x) => x.trim()).filter(Boolean);
  const styles = only ?? (await liveStyleCodes());
  const rows: ExtendedRow[] = [];
  let i = 0;
  for (const s of styles) {
    i++;
    if (i % 20 === 0) console.log(`  ... ${i}/${styles.length}`);
    try {
      const r = await planExtended(s);
      if (r) rows.push(r);
    } catch (e) {
      console.log(`  ${s}: ERROR ${e instanceof Error ? e.message : e}`);
    }
  }
  const md = reportMarkdown(rows, styles.length);
  writeFileSync("extended-sizes-report.md", md);
  console.log(md);
  console.log("Written: extended-sizes-report.md (read-only; nothing written to the DB or Shopify)");
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const execute = process.argv.includes("--execute");
  if (cmd === "seed") return seed(execute);
  if (cmd === "relabel") return relabel(execute);
  if (cmd === "rollback") return rollback(execute);
  if (cmd === "relabel-batch") return relabelBatch(execute);
  if (cmd === "rollback-batch") return rollbackBatch(execute);
  if (cmd === "status") return status();
  if (cmd === "post-check") return postCheck();
  if (cmd === "drop-old-sizes") return dropOldSizes(execute);
  if (cmd === "add-sizes") return addSizes(execute);
  if (cmd === "extended-report") return extendedReport();
  if (cmd === "add-sizes-batch") return addSizesBatch(execute);
  if (cmd === "add-sizes-rollback") return addSizesRollback(execute);
  throw new Error(`unknown command "${cmd}" — expected: seed | relabel | rollback | relabel-batch | rollback-batch | add-sizes | add-sizes-batch | add-sizes-rollback | extended-report | status | post-check | drop-old-sizes`);
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
