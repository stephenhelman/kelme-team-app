/**
 * Color values for new Kelme colors. DRY-RUN by default; only --execute writes Shopify (+ the Color table).
 *
 *   npm run colors -- seed [--codes 214,813]      # dry run: prints each metaobjectCreate and what it would store
 *   npm run colors -- seed --execute              # creates the approved, missing color values; stores GIDs on Color rows
 *
 * Only colors in COLOR_SEED_MAP (lib/color-seed.ts) are ever created. Any other color lacking a Shopify value is
 * listed with a suggested mapping and refused until a person adds it to that map.
 */
import { prisma } from "@/lib/prisma";
import { colorCreateVariables, executeColorSeed, planColorSeed, COLOR_SEED_MAP, TAXONOMY_COLOR } from "@/lib/color-seed";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function seed(execute: boolean) {
  const codes = arg("codes")?.split(",").map((s) => s.trim()).filter(Boolean);
  const plan = await planColorSeed({ codes });
  console.log("code  name                 status          shopify-metaobject                       color-table-gid                          action");
  for (const r of plan.rows) console.log(`${r.code.padEnd(5)} ${r.name.padEnd(20)} ${r.status.padEnd(15)} ${(r.existingGid ?? "(missing)").padEnd(40)} ${(r.tableGid ?? "(none)").padEnd(40)} ${r.action}`);
  for (const c of plan.creates) {
    const taxNames = c.entry.taxonomyColors.map((n) => `${n}=${TAXONOMY_COLOR[n]}`).join(", ");
    console.log(`\nWOULD CREATE ${c.code} "${c.entry.name}"  [taxonomy ${taxNames}; pattern ${c.entry.pattern}; swatch ${c.entry.hex}]:\n${JSON.stringify(colorCreateVariables(c.code, c.entry), null, 2)}`);
  }
  const refused = plan.rows.filter((r) => r.action === "refused");
  for (const r of refused) {
    console.log(`\nNOT APPROVED ${r.code} "${r.name}" — nothing will be created. Suggested: ${r.suggestion!.taxonomyColors.join(" + ") || "(none recognised)"}, pattern ${r.suggestion!.pattern}; ${r.suggestion!.note}. Approve by adding it to COLOR_SEED_MAP (lib/color-seed.ts).`);
  }
  const melange = COLOR_SEED_MAP["222"];
  if (plan.creates.some((c) => c.code === "222") && melange) console.log("\nNOTE 222 Melange Gray: Shopify's Pattern taxonomy has no heathered/melange value, so it is created as Solid.");
  const todo = plan.rows.filter((r) => r.action === "create-metaobject+store" || r.action === "store-gid").length;
  console.log(`\n${plan.creates.length} metaobject(s) to create, ${todo} Color-table row(s) to write, ${refused.length} refused (not approved).`);
  if (!execute) return console.log("DRY RUN — nothing written. Re-run with --execute.");
  const done = await executeColorSeed(plan);
  for (const d of done) console.log(`${d.created ? "created" : "linked "} ${d.code} -> ${d.gid} ${d.verified ? "(read-back matches)" : "(READ-BACK DIFFERS — check in Shopify admin)"}`);
  if (done.some((d) => !d.verified)) process.exitCode = 1;
  console.log("Done. Re-run `npm run drafts -- create --all` (dry-run) to see the newly unblocked styles.");
}

async function main() {
  const [cmd] = process.argv.slice(2);
  if (cmd === "seed") return seed(process.argv.includes("--execute"));
  throw new Error(`unknown command "${cmd}" — expected: seed`);
}
main().then(() => prisma.$disconnect()).then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
