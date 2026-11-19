/**
 * Report (and, with --execute, apply) things the vendor deleted from Shopify on purpose.
 *
 *   npm run vendor-deletions                 dry-run: reads Shopify + DB, lists deleted products and removed variants
 *   npm run vendor-deletions -- --execute    applies, in this order:
 *       1. relink (matches + nulls dead ids + onShopify:false + DraftJob DELETED_BY_VENDOR for whole products)
 *       2. records removed colors/sizes on still-live products (VendorRemoval) and deletes those DB variant rows,
 *          so capture / rebuild / add-sizes / the new-variant alert never recreate them
 *
 * Needs the VendorRemoval table: `npx prisma migrate deploy` first.
 */
import { prisma } from "@/lib/prisma";
import { dryRunRelink, executeRelink } from "@/lib/shopify-relink";
import { applyVariantRemovals } from "@/lib/vendor-deletions";

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const dry = await dryRunRelink();
  const d = dry.vendorDeletions;
  const jobs = await prisma.draftJob.findMany({ where: { styleCode: { in: d.deletedProducts.map((p) => p.styleCode) } }, select: { styleCode: true, status: true } }).catch(() => []);
  const jobBy = new Map(jobs.map((j) => [j.styleCode, j.status]));

  console.log(`\nDELETED PRODUCTS (${d.deletedProducts.length}) — gone from Shopify, DB still pointed at them:`);
  for (const p of d.deletedProducts) console.log(`  ${p.styleCode.padEnd(16)} ${String(p.variants).padStart(3)} variants  ${String(p.qty).padStart(6)} units  draftJob=${jobBy.get(p.styleCode) ?? "(none)"}`);

  console.log(`\nREMOVED VARIANTS on live products (${d.removedVariants.length}):`);
  for (const r of d.removedVariants) console.log(`  ${r.sku}  qty ${r.qty}`);

  console.log(`\ndead ids to null (deleted products): ${d.staleVariantDbIds.length}`);
  if (!execute) {
    console.log("\nDry-run only. Re-run with --execute to apply.");
    await prisma.$disconnect();
    return;
  }

  const result = await executeRelink();
  console.log(`relink: updated=${result.updated} staleLinksNulled=${result.staleLinksNulled} deletedProducts=${result.deletedProducts.length} flippedOff=${result.flippedOff.length}`);
  if (d.removedVariants.length > 0) {
    const r = await applyVariantRemovals(d.removedVariants, dry._allDbVariants ?? [], `vendor deleted in Shopify admin; recorded ${new Date().toISOString()}`);
    console.log(`vendor removals recorded: ${r.rows} row(s), ${r.deletedVariants} DB variant row(s) deleted`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
