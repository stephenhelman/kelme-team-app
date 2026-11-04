/**
 * Weight backfill for per-unit shipping. DRY-RUN by default.
 *
 *   npm run shipping:weights               # counts only, writes nothing
 *   npm run shipping:weights -- --execute  # set 1 lb + requiresShipping on every core
 *                                          # variant; 0 lb + requiresShipping=false on the
 *                                          # 4 customize_charge fee items; then re-read
 *                                          # and report any variant not at target
 *
 * Needs the write_products scope. Only variants not already at target are written.
 */
import { isAtTarget, scanWeights, writeWeights, type VariantState } from "@/lib/shipping-weights";
import { CORE_WEIGHT_LB, FEE_WEIGHT_LB } from "@/lib/shipping-config";

const describe = (v: VariantState) => `${v.sku ?? v.id} [${v.productTitle}] weight=${v.weightLb ?? "none"}lb ships=${v.requiresShipping}`;

async function main() {
  const execute = process.argv.includes("--execute");
  const scan = await scanWeights();
  const core = scan.variants.filter((v) => v.role === "core");
  const fee = scan.variants.filter((v) => v.role === "fee");
  const todo = scan.variants.filter((v) => !isAtTarget(v));

  console.log(`core products ${scan.coreProducts}, core variants ${core.length} (${core.filter(isAtTarget).length} already ${CORE_WEIGHT_LB} lb + ships)`);
  console.log(`fee products ${scan.feeProducts.length} (${scan.feeProducts.map((p) => p.title).join(", ")}), fee variants ${fee.length} (${fee.filter(isAtTarget).length} already ${FEE_WEIGHT_LB} lb + no shipping)`);
  for (const p of scan.feeTitleProblems) console.log(`WARNING: ${p}`);
  console.log(`to write: ${todo.length} (${todo.filter((v) => v.role === "core").length} core, ${todo.filter((v) => v.role === "fee").length} fee)`);

  if (!execute) {
    console.log("DRY RUN — nothing written. Re-run with --execute.");
    return;
  }
  if (scan.feeTitleProblems.length > 0) throw new Error("Refusing to write: fix the fee product title problems above first.");

  const written = await writeWeights(todo);
  console.log(`wrote ${written} variants; re-reading...`);

  const after = await scanWeights();
  const bad = after.variants.filter((v) => !isAtTarget(v));
  console.log(`re-read ${after.variants.length} variants: ${after.variants.length - bad.length} at target, ${bad.length} NOT at target`);
  for (const v of bad.slice(0, 200)) console.log(`  MISMATCH ${describe(v)} (expected ${v.role === "core" ? CORE_WEIGHT_LB : FEE_WEIGHT_LB} lb)`);
  if (bad.length > 0) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0), (e) => { console.error(e); process.exit(1); });
