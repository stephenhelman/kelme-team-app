/**
 * Size standardization tooling. DRY-RUN by default — nothing writes without --execute.
 *
 *   npm run sizes -- seed                 # step 2: show size metaobjects to create + Size-table rows
 *   npm run sizes -- seed --execute       # create "2"/"XXS" (if missing) and store GIDs in the Size table
 */
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

async function main() {
  const [cmd] = process.argv.slice(2);
  const execute = process.argv.includes("--execute");
  if (cmd === "seed") return seed(execute);
  throw new Error(`unknown command "${cmd}" — expected: seed`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
