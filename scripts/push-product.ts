/**
 * Supervised single-product inventory push — the DB -> Shopify stage only,
 * narrowed to one styleCode. DRY-RUN by default: prints exactly what would
 * be written (current on_hand -> target, with the changeFromQuantity that
 * would guard each write) and touches nothing. Writes only with --execute.
 *
 * Usage:
 *   npm run push:product -- <styleCode>             # dry-run
 *   npm run push:product -- <styleCode> --execute   # one real cycle
 *
 * Reads DB qty as-is; run the pull/apply stage first if you want it fresh.
 */
import { dryRunPush, executePush } from "@/lib/shopify-inventory-push";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

async function main(): Promise<void> {
  const styleCode = process.argv[2];
  const execute = process.argv.includes("--execute");
  if (!styleCode || styleCode.startsWith("--")) {
    console.error("Usage: npm run push:product -- <styleCode> [--execute]");
    process.exit(1);
  }

  console.log(`Admin API ${SHOPIFY_API_VERSION} — ${execute ? "EXECUTE" : "dry-run"} for styleCode ${styleCode}`);
  const plan = await dryRunPush(styleCode);
  console.log(
    `location="${plan.location.name}" matchesExpected=${plan.location.matchesExpectedAddress} ` +
      `variants=${plan.totalOnShopifyVariants} alreadyCorrect=${plan.alreadyCorrect} toPush=${plan.toPush.length} staleItems=${plan.staleItems.length} ` +
      `suspiciousDrops=${plan.suspiciousDrops.length} trackingDisabled=${plan.trackingDisabledCount} ` +
      `nullInventoryItemId=${plan.nullInventoryItemId.length}`,
  );
  for (const c of plan.toPush) {
    console.log(`  ${c.sku}: on_hand ${c.currentOnHand} -> ${c.targetQty} (changeFromQuantity=${c.currentOnHand})${c.trackingDisabled ? " [enable tracking]" : ""}`);
  }
  if (plan.totalOnShopifyVariants === 0) {
    console.error(`No onShopify variants for styleCode "${styleCode}".`);
    process.exit(1);
  }
  if (!execute) {
    console.log("Dry-run only. Re-run with --execute to write.");
    return;
  }

  const report = await executePush({ styleCode, cycleId: `single-${styleCode}-${new Date().toISOString()}` });
  console.log(
    `EXECUTE ok=${report.ok} failed=${report.failed} casConflicts=${report.casConflicts} skippedStale=${report.skippedStale} ` +
      `trackingEnabled=${report.trackingEnabled} trackingFailed=${report.trackingFailed.length}`,
  );
  for (const e of report.entries.filter((x) => x.status !== "ok")) console.log(`  ${e.status}: ${e.inventoryItemGid} ${e.message ?? ""}`);

  const after = await dryRunPush(styleCode);
  console.log(`Re-check: ${after.toPush.length} variants still differ (expected 0).`);
  if (report.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
