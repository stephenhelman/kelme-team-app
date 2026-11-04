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
 *       --notify-to you@example.com emails the summary to THAT address only
 *       (a test send). The client is never emailed by create/batch — use the
 *       separate `notify` command below once the run has succeeded.
 *
 *   npm run drafts -- batch (--styleCode A,B | --all-clean) [--include-no-size]
 *                          [--execute] [--continue-on-error] [--notify-to x]
 *       Dry-run lists what would be created and what is skipped. --execute
 *       creates the drafts one at a time (stops on the first failure unless
 *       --continue-on-error); --notify-to sends ONE test summary to that
 *       address only. --all-clean selects
 *       pre-flight-clean apparel only; --include-no-size adds clean One-Size
 *       products (socks) as a separate deliberate run. Flagged products and
 *       products needing a >100-variant split are never selected.
 *
 *   npm run drafts -- notify (--styleCode A,B | --unnotified) [--send] [--force]
 *       Run AFTER a successful --execute. Dry-run by default: shows the exact
 *       email (recipients, subject, body; HTML to draft-email-preview.html)
 *       for drafts whose execute run verified clean, built from live Shopify
 *       state. --send emails the client (KELME_VENDOR_EMAIL, cc
 *       ADMIN_NOTIFY_EMAIL) and records it so they are never emailed twice
 *       about the same product (--force overrides).
 *
 *   npm run drafts -- verify --styleCode X
 *       Read-only: re-reads X's draft from Shopify and reports the checks.
 */
import { prisma } from "@/lib/prisma";
import { runPreflight, writeReport, REPORT_MD } from "@/lib/draft-preflight";
import { executeDraft, planDraft, previewMutations, verifyDraft, type DraftPlan, type VerifyReport } from "@/lib/shopify-draft";
import { SHOPIFY_API_VERSION, shopDomain } from "@/lib/shopify";
import { buildNotifySelection, recordNotified } from "@/lib/draft-notify";
import { notifyProductsAdded, renderProductsAddedEmail } from "@/lib/product-added-notify";
import { writeFile } from "fs/promises";
import { dryRunDraftBatch, executeDraftBatch, selectAllClean } from "@/lib/shopify-draft-batch";

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
  const styleCodeArg = opt("styleCode");
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
  if (cmd === "batch") {
    const execute = flag("execute");
    console.log(`Admin API ${SHOPIFY_API_VERSION} — batch ${execute ? "EXECUTE" : "dry-run"}`);
    let codes: string[];
    if (flag("all-clean")) {
      const sel = await selectAllClean({ includeNoSize: flag("include-no-size") });
      codes = sel.selected;
      console.log(`--all-clean selected ${codes.length}; skipped ${sel.skipped.length} (see draft pre-flight report for flag detail)`);
    } else if (styleCodeArg) {
      codes = styleCodeArg.split(",").map((c) => c.trim()).filter(Boolean);
    } else {
      console.error("Usage: npm run drafts -- batch (--styleCode A,B | --all-clean) [--include-no-size] [--execute] [--continue-on-error] [--notify-to x]");
      process.exit(1);
    }
    const plans = await dryRunDraftBatch(codes);
    for (const p of plans) {
      console.log(`${p.blockers.length > 0 ? "BLOCKED" : "ok     "} ${p.styleCode.padEnd(14)} ${String(p.variants).padStart(3)} variants ${p.images} images qty ${String(p.qty).padStart(3)}  ${p.title}${p.blockers.length > 0 ? `\n         ${p.blockers.join("; ")}` : ""}`);
    }
    const ready = plans.filter((p) => p.blockers.length === 0);
    console.log(`\n${ready.length} ready, ${plans.length - ready.length} blocked; ${ready.reduce((n, p) => n + p.variants, 0)} variants total.`);
    if (!execute) {
      console.log("Dry-run only. Nothing was sent to Shopify. Re-run with --execute to create these drafts.");
      return;
    }
    const result = await executeDraftBatch(ready.map((p) => p.styleCode), { continueOnError: flag("continue-on-error") });
    console.log("\n===== batch summary =====");
    for (const o of result.outcomes) console.log(`${o.status.padEnd(8)} ${o.styleCode}${o.message ? ` — ${o.message}` : ""}`);
    if (result.stoppedEarly) console.log(`STOPPED EARLY: ${result.stoppedEarly}`);
    const created = result.outcomes.flatMap((o) => (o.summary ? [o.summary] : []));
    const notifyTo = opt("notify-to");
    if (created.length > 0 && notifyTo) {
      const sent = await notifyProductsAdded(created, { adminBaseUrl: `https://${shopDomain()}/admin`, to: notifyTo, cc: null });
      console.log(`Emailed one summary for ${created.length} product(s) to ${sent.to} (resend id ${sent.id ?? "n/a"}) — test send, client NOT emailed`);
    }
    if (result.stoppedEarly || result.outcomes.some((o) => o.status === "failed")) process.exitCode = 1;
    return;
  }
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
    const notifyTo = opt("notify-to");
    if (notifyTo) {
      if (result.verify.problems.length > 0) {
        console.log("Not emailing: verification found problems.");
      } else {
        const sent = await notifyProductsAdded([result.summary], { adminBaseUrl: `https://${shopDomain()}/admin`, to: notifyTo, cc: null });
        console.log(`Emailed "products added" summary to ${sent.to} (resend id ${sent.id ?? "n/a"}) — test send, client NOT emailed`);
      }
    }
    return;
  }
  if (cmd === "notify") {
    if (!flag("unnotified") && !styleCodeArg) {
      console.error("Usage: npm run drafts -- notify (--styleCode A,B | --unnotified) [--send] [--force]");
      process.exit(1);
    }
    const sel = await buildNotifySelection({
      styleCodes: styleCodeArg?.split(",").map((c) => c.trim()).filter(Boolean),
      unnotified: flag("unnotified"),
      force: flag("force"),
    });
    for (const k of sel.skipped) console.log(`skipped ${k.styleCode}: ${k.reason}`);
    if (sel.products.length === 0) {
      console.log("Nothing to send.");
      return;
    }
    const base = `https://${shopDomain()}/admin`;
    const mail = renderProductsAddedEmail(sel.products, base);
    const to = process.env.KELME_VENDOR_EMAIL;
    const cc = process.env.ADMIN_NOTIFY_EMAIL;
    await writeFile("draft-email-preview.html", mail.html, "utf8");
    console.log(`To: ${to ?? "(KELME_VENDOR_EMAIL NOT SET)"}${cc ? `   Cc: ${cc}` : ""}\nSubject: ${mail.subject}\n\n${mail.text}\n\nHTML preview: draft-email-preview.html`);
    if (!flag("send")) {
      console.log(`\nDry-run only — nothing sent. Re-run with --send to email the client about ${sel.products.length} product(s).`);
      return;
    }
    const sent = await notifyProductsAdded(sel.products, { adminBaseUrl: base });
    await recordNotified(sel.products, sent.to, sent.id);
    console.log(`\nSENT to ${sent.to} (resend id ${sent.id ?? "n/a"}) for ${sel.products.length} product(s).`);
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
