/**
 * Draft product creation from Kelme favorites. DRY-RUN by default for every
 * subcommand; only --execute writes Shopify.
 *
 *   npm run drafts -- preflight [--capture] [--styleCode A,B]
 *       Evaluates every favorites-only candidate and writes
 *       draft-preflight-report.md / draft-preflight.json. --capture first
 *       re-captures from Kelme into the DB (DB writes only; never Shopify).
 *
 *   npm run drafts -- create --styleCode X [--execute] [--resume]
 *       Dry-run prints the full plan + the exact mutation payloads. --execute
 *       re-captures X from Kelme, creates ONE DRAFT product and verifies it.
 *       --resume continues a partially-built draft (same title, status DRAFT).
 *
 *   npm run drafts -- verify --styleCode X
 *       Read-only: re-reads X's draft from Shopify and reports the checks.
 */
import { prisma } from "@/lib/prisma";
import { runPreflight, writeReport, REPORT_MD } from "@/lib/draft-preflight";
import { executeDraft, planDraft, previewMutations, verifyDraft, type DraftPlan, type VerifyReport } from "@/lib/shopify-draft";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

function printPlan(plan: DraftPlan): void {
  console.log(`styleCode      ${plan.styleCode} (pdtid ${plan.pdtid})`);
  console.log(`title          ${plan.title}`);
  console.log(`vendor/status  ${plan.vendor} / ${plan.status}`);
  console.log(`tags           ${plan.tags.join(", ")}`);
  console.log(`category       ${plan.category ? `${plan.category.label}  [${plan.category.gid}]` : "NONE"}`);
  console.log(`price          ${plan.price} (${plan.priceSource})`);
  console.log(`options        Color (${plan.colorValues.length})${plan.sizeOptionName ? `, ${plan.sizeOptionName} (${plan.sizeValues.length})` : ", no size dimension"}`);
  console.log(`variants       ${plan.variants.length}  total Kelme qty ${plan.variants.reduce((n, v) => n + v.qty, 0)} (captured ${plan.qtyCapturedAt?.toISOString() ?? "unknown"}; --execute re-captures first)`);
  for (const v of plan.variants) console.log(`   ${v.sku.padEnd(26)} ${v.colorName} - ${v.colorCode} / ${v.size}  qty ${v.qty}`);
  console.log(`images         ${plan.images.length} (${plan.colorsWithoutImage.length} colors without)`);
  for (const i of plan.images) console.log(`   ${i.filename}  <- ${i.sourceUrl}`);
  console.log(`description    ${plan.descriptionHtml.replace(/\n/g, " ").slice(0, 300)}`);
  if (plan.existingOnShopify.length > 0) console.log(`ALREADY ON SHOPIFY: ${plan.existingOnShopify.map((e) => `${e.id} [${e.status}] ${e.title}`).join(" | ")}`);
  console.log(plan.blockers.length > 0 ? `BLOCKERS: ${plan.blockers.join("; ")}` : "blockers       none");
}

function printVerify(v: VerifyReport): void {
  console.log(`product        ${v.productId}`);
  console.log(`status/vendor  ${v.status} / ${v.vendor}`);
  console.log(`title          ${v.title}`);
  console.log(`tags           ${v.tags.join(", ")}`);
  console.log(`category       ${v.category}`);
  console.log(`options        ${v.options.map((o) => `${o.name}[linked:${o.linkedKey ?? "NO"}, ${o.values} values]`).join("  ")}`);
  console.log(`variants       ${v.variantCount} (expected ${v.expectedVariantCount})`);
  console.log(`images         ${v.imagesAttached} on product (expected ${v.expectedImages}); ${v.variantsWithMedia}/${v.variantCount} variants have media`);
  for (const p of v.perVariant) console.log(`   ${p.sku.padEnd(26)} price ${p.price} tracked ${p.tracked} on_hand ${p.onHand} (Kelme ${p.expectedQty}) media ${p.hasMedia}`);
  console.log(v.problems.length === 0 ? "VERIFY OK — no problems" : `VERIFY PROBLEMS (${v.problems.length}):\n  - ${v.problems.join("\n  - ")}`);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "preflight") {
    const only = opt("styleCode")?.split(",").map((s) => s.trim()).filter(Boolean);
    const run = await runPreflight({ capture: flag("capture"), only });
    await writeReport(run);
    const clean = run.results.filter((r) => r.clean).length;
    console.log(`pre-flight: ${run.results.length} candidates, ${clean} clean, ${run.results.length - clean} flagged`);
    console.log(`report: ${REPORT_MD}`);
    return;
  }
  const styleCode = opt("styleCode");
  if ((cmd === "create" || cmd === "verify") && !styleCode) {
    console.error(`Usage: npm run drafts -- ${cmd} --styleCode X${cmd === "create" ? " [--execute] [--resume]" : ""}`);
    process.exit(1);
  }
  if (cmd === "create") {
    const execute = flag("execute");
    console.log(`Admin API ${SHOPIFY_API_VERSION} — ${execute ? "EXECUTE" : "dry-run"}${flag("resume") ? " (resume)" : ""}`);
    const plan = await planDraft(styleCode!);
    printPlan(plan);
    if (!execute) {
      console.log("\n--- productCreate variables ---");
      const m = previewMutations(plan);
      console.log(JSON.stringify(m.productCreate, null, 1));
      console.log("\n--- productSet input (product id supplied at run time; first 3 variants) ---");
      const ps = m.productSet as { productOptions: unknown; variants: unknown[] };
      console.log(JSON.stringify({ ...ps, variants: ps.variants.slice(0, 3) }, null, 1));
      console.log("\nDry-run only. Nothing was sent to Shopify. Re-run with --execute to create the draft.");
      return;
    }
    const result = await executeDraft(styleCode!, { resume: flag("resume") });
    console.log(`\n${result.createdNew ? "CREATED" : "RESUMED"} ${result.productId}; media uploaded this run: ${result.mediaUploaded}\n`);
    printVerify(result.verify);
    if (result.verify.problems.length > 0) process.exitCode = 1;
    return;
  }
  if (cmd === "verify") {
    const plan = await planDraft(styleCode!);
    if (plan.existingOnShopify.length !== 1) {
      console.error(`Expected exactly 1 Shopify product for ${styleCode}, found ${plan.existingOnShopify.length}`);
      process.exit(1);
    }
    printVerify(await verifyDraft(plan.existingOnShopify[0].id, plan));
    return;
  }
  console.error("Usage: npm run drafts -- preflight|create|verify ...");
  process.exit(1);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
