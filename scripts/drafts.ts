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
 *   npm run drafts -- create --all [--limit N] [--only A,B] [--execute]
 *       EVERY Kelme favorite not on Shopify (any status) becomes a DRAFT. The only
 *       blockers are an unknown Kelme size label or a Shopify API error; missing
 *       images/category/audience just add needs-* tags. Dry-run reads Kelme live
 *       (no DB or Shopify writes), prints sizes created / left off / tags per
 *       product and writes draft-email-preview.html. --execute creates them one
 *       at a time behind the DraftJob lock (re-runs never duplicate), stops on
 *       the first Shopify failure, and prints the run id for the email step.
 *       Add --email [--to someone@example.com] to email the drafts this run created right after it finishes.
 *
 *   npm run drafts -- email --run <id> [--to someone@example.com] [--send]
 *       The vendor email ("X new products are ready for you to price") for the
 *       drafts one run created. Dry-run prints it and writes draft-email-preview.html;
 *       --send emails KELME_VENDOR_EMAIL (cc ADMIN_NOTIFY_EMAIL), once per run.
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
import { fetchFavorites, loadSelection, planDrafts, previewEmailItem, runDrafts } from "@/lib/draft-run";
import { fetchLiveCategoryMap } from "@/lib/draft-category";
import { createDraftTracked, runEmailItems } from "@/lib/draft-jobs";
import { renderNewDraftsEmail, sendNewDraftsEmail } from "@/lib/draft-email";
import { COLOR_SEED_MAP, suggestMapping } from "@/lib/color-seed";

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
  for (const p of v.perVariant) console.log(`   ${p.sku.padEnd(26)} price ${p.price} tracked ${p.tracked} on_hand ${p.onHand} (Kelme ${p.expectedQty}) media ${p.hasMedia} weight ${p.weightLb}lb ships ${p.requiresShipping}`);
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
  if (cmd === "create" && flag("all")) {
    const execute = flag("execute");
    const limit = opt("limit") ? Number(opt("limit")) : undefined;
    const only = opt("only")?.split(",").map((x) => x.trim()).filter(Boolean);
    console.log(`Admin API ${SHOPIFY_API_VERSION} — create --all ${execute ? "EXECUTE" : "dry-run"}`);
    if (execute) {
      const rep = await runDrafts({ source: "manual", cap: limit, only });
      console.log(`\n===== run ${rep.runId} summary =====`);
      console.log(`created ${rep.created.length}, blocked ${rep.blocked.length}, failed ${rep.failed.length}, skipped ${rep.skipped.length}, left for next run ${rep.overCap.length}`);
      for (const o of [...rep.blocked, ...rep.failed, ...rep.skipped]) console.log(`  ${o.status.padEnd(8)} ${o.styleCode} — ${o.message ?? ""}`);
      for (const h of rep.needsHuman) console.log(`  needs a person: ${h.styleCode} is ${h.status} — npm run drafts -- create --styleCode ${h.styleCode} --execute --resume`);
      if (rep.stoppedReason) {
        console.log(`STOPPED: ${rep.stoppedReason}\nFix it, then re-run the same command — finished styles are skipped (lock), nothing duplicates.`);
        process.exitCode = 1;
      }
      if (flag("email")) {
        // Opt-in: email right after the run, only about the drafts this run created. --to overrides KELME_VENDOR_EMAIL.
        const items = await runEmailItems(rep.runId);
        if (items.length === 0) console.log("\n--email: nothing was created, so nothing to email.");
        else {
          const sent = await sendNewDraftsEmail(items, { adminBaseUrl: `https://${shopDomain()}/admin`, runId: rep.runId, to: opt("to") });
          await prisma.draftRun.update({ where: { id: rep.runId }, data: { emailedAt: new Date(), emailedTo: sent.to } });
          console.log(`\nEMAILED ${items.length} draft(s) to ${sent.to}${sent.cc ? ` (cc ${sent.cc})` : ""} (resend id ${sent.id ?? "n/a"}).`);
        }
      } else {
        console.log(`\nNext: npm run drafts -- email --run ${rep.runId}   (dry-run preview; add --send to email the vendor)`);
      }
      return;
    }
    const favs = await fetchFavorites();
    let sel = await loadSelection(favs, limit);
    if (only?.length) sel = { ...sel, pending: sel.pending.filter((f) => only.includes(f.no)) };
    console.log(`${favs.length} Kelme favorites; ${sel.alreadyOnShopify} already on Shopify (any status) or created; ${sel.pending.length + sel.overCap.length} to create${sel.needsHuman.length ? `; ${sel.needsHuman.length} need a person (earlier failure)` : ""}`);
    const catMap = await fetchLiveCategoryMap();
    console.log(`live categories known for ${catMap.size} Kelme sub-categories`);
    const planned = await planDrafts(sel.pending, catMap, (i, n) => i % 10 === 0 && console.log(`  planned ${i}/${n}`));
    let variants = 0, qty = 0, offVariants = 0, blockedN = 0;
    const tagCount = new Map<string, number>();
    for (const p of planned) {
      if (p.error) {
        console.log(`ERROR   ${p.favorite.no}: ${p.error}`);
        blockedN++;
        continue;
      }
      const e = p.evaluation;
      const blocked = e.blockers.length > 0;
      if (blocked) blockedN++;
      else {
        variants += e.variantCount;
        qty += p.totalQty;
      }
      offVariants += p.source.leftOff.length;
      for (const t of e.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
      console.log(`${blocked ? "BLOCKED" : "create "} ${e.styleCode.padEnd(14)} ${String(e.variantCount).padStart(3)} variants  sizes [${e.sizesCreated.join(" ")}]  left off [${e.sizesLeftOff.join(" ") || "-"}]`);
      console.log(`         ${e.title}`);
      console.log(`         tags: ${e.tags.join(", ")} | category: ${e.category ? `${e.category.label.split(" > ").slice(-2).join(" > ")} (${e.categorySource})` : "NONE"} | to-do: ${e.todos.map((t) => t).join(", ")}`);
      if (blocked) console.log(`         BLOCKERS: ${e.blockers.join("; ")}`);
    }
    // Colors with no Shopify value (their styles stay blocked until `npm run colors -- seed --execute`).
    const unseeded = new Map<string, { name: string; styles: Set<string> }>();
    for (const p of planned) {
      if (p.error) continue;
      for (const code of p.source.colorsMissingGid) {
        const e = unseeded.get(code) ?? { name: p.source.variants.find((v) => v.colorCode === code)?.colorName ?? "?", styles: new Set<string>() };
        e.styles.add(p.favorite.no);
        unseeded.set(code, e);
      }
    }
    if (unseeded.size > 0) {
      console.log(`\nUNSEEDED COLORS (${unseeded.size}) — blocking ${new Set([...unseeded.values()].flatMap((e) => [...e.styles])).size} style(s):`);
      for (const [code, e] of [...unseeded].sort()) {
        const approved = COLOR_SEED_MAP[code];
        console.log(`  ${code} ${e.name}: ${approved ? "approved mapping exists — run `npm run colors -- seed --execute`" : `NOT approved; suggested ${suggestMapping(e.name).taxonomyColors.join(" + ") || "(none)"} — add to COLOR_SEED_MAP first`}  [${[...e.styles].join(", ")}]`);
      }
    }
    const ok = planned.filter((p) => !p.error && p.evaluation.blockers.length === 0);
    console.log(`\n===== dry-run summary =====\n${ok.length} would be created (${variants} variants, ${qty} Kelme units); ${blockedN} blocked; ${offVariants} variants left off (policy-excluded sizes)`);
    console.log(`tags: ${[...tagCount].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} x${n}`).join(", ")}`);
    console.log(`categories: ${["rule", "live-catalog", "none"].map((k) => `${k} ${ok.filter((p) => p.evaluation.categorySource === k).length}`).join(", ")}`);
    const mail = renderNewDraftsEmail(ok.map(previewEmailItem), `https://${shopDomain()}/admin`);
    await writeFile("draft-email-preview.html", mail.html, "utf8");
    console.log(`\nEmail preview (links are placeholders until drafts exist): draft-email-preview.html\nSubject: ${mail.subject}`);
    console.log("\nDry-run only. Nothing was written to the DB or Shopify. Re-run with --execute.");
    return;
  }
  if (cmd === "email") {
    const runId = Number(opt("run"));
    if (!runId) {
      console.error("Usage: npm run drafts -- email --run <id> [--send]");
      process.exit(1);
    }
    const run = await prisma.draftRun.findUnique({ where: { id: runId } });
    if (!run) throw new Error(`no DraftRun ${runId}`);
    const items = await runEmailItems(runId);
    if (items.length === 0) return console.log(`Run ${runId} created no drafts — nothing to email.`);
    const base = `https://${shopDomain()}/admin`;
    const mail = renderNewDraftsEmail(items, base);
    await writeFile("draft-email-preview.html", mail.html, "utf8");
    console.log(`To: ${opt("to") ?? process.env.KELME_VENDOR_EMAIL ?? "(KELME_VENDOR_EMAIL NOT SET)"}   Cc: ${process.env.ADMIN_NOTIFY_EMAIL ?? "(none)"}\nSubject: ${mail.subject}\n\n${mail.text}\n\nHTML preview: draft-email-preview.html`);
    if (run.emailedAt) console.log(`\nNOTE: run ${runId} was already emailed to ${run.emailedTo} at ${run.emailedAt.toISOString()}.`);
    if (!flag("send")) return console.log(`\nDry-run only — nothing sent. Re-run with --send to email the vendor about ${items.length} draft(s).`);
    if (run.emailedAt && !flag("force")) throw new Error("already emailed — pass --force to send again");
    const sent = await sendNewDraftsEmail(items, { adminBaseUrl: base, runId, to: opt("to") });
    await prisma.draftRun.update({ where: { id: runId }, data: { emailedAt: new Date(), emailedTo: sent.to } });
    console.log(`\nSENT to ${sent.to}${sent.cc ? ` (cc ${sent.cc})` : ""} for ${items.length} draft(s) (resend id ${sent.id ?? "n/a"}).`);
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
    const run = await prisma.draftRun.create({ data: { source: "manual", pending: 1 } });
    const out = await createDraftTracked(styleCode!, { runId: run.id, resume: flag("resume") });
    await prisma.draftRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), created: out.status === "created" ? 1 : 0, failed: out.status === "failed" ? 1 : 0, blocked: out.status === "blocked" ? 1 : 0 } });
    console.log(`\n${out.status.toUpperCase()} ${styleCode}${out.productGid ? ` ${out.productGid}` : ""}${out.message ? ` — ${out.message}` : ""}  (run ${run.id})\n`);
    if (out.verify) printVerify(out.verify);
    if (out.status !== "created") {
      process.exitCode = 1;
      return;
    }
    const notifyTo = opt("notify-to");
    if (notifyTo) {
      // Test send of the new vendor email to THAT address only (no cc); the vendor is never emailed from `create`.
      const sent = await sendNewDraftsEmail([out.emailItem!], { adminBaseUrl: `https://${shopDomain()}/admin`, runId: run.id, to: notifyTo });
      console.log(`Emailed the "ready for you to price" preview to ${sent.to} (resend id ${sent.id ?? "n/a"}) — test send, vendor NOT emailed`);
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
