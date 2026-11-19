/**
 * Pure decisions + alert text for the sync worker (worker/index.ts), kept here so they are unit-tested
 * without a DB or Shopify.
 */
export const PUSH_FAILURE_ALERT_THRESHOLD = 20;
export const VERIFY_MISMATCH_ALERT_THRESHOLD = 20;

/** The heartbeat must only advance on a cycle whose push actually worked: failed items mean Shopify is NOT in sync. */
export function shouldRecordSuccessfulSync(pushFailed: number): boolean {
  return pushFailed === 0;
}

/** A relink is worth running when the push saw deleted items (skipped_stale) or failed with a stale-id message. */
export function shouldRelink(push: { skippedStale: number; failed: number; hasStaleIdFailure: boolean }): boolean {
  return push.skippedStale > 0 || (push.failed > 0 && push.hasStaleIdFailure);
}

export function skippedStaleAlertBody(entries: { variantId: number; inventoryItemGid: string; message?: string }[], skus: Map<number, string>, limit = 40): string {
  const lines = entries.slice(0, limit).map((e) => `  - ${skus.get(e.variantId) ?? `variant ${e.variantId}`}: ${e.message ?? e.inventoryItemGid}`);
  const more = entries.length > limit ? `\n  ...and ${entries.length - limit} more` : "";
  return (
    `${entries.length} variants were NOT pushed this cycle because their Shopify inventory item no longer exists ` +
    `(product or variant deleted in Shopify admin). The rest of the push went through.\n\n${lines.join("\n")}${more}\n\n` +
    "A relink clears them (nulls the stale ids and flips the product off Shopify). If the deletion was a mistake, recreate the product."
  );
}

export function flipAlertBody(
  flips: { styleCode: string; variants: number; qty: number }[],
  deleted: { styleCode: string }[] = [],
  removedVariants: { sku: string }[] = [],
): string {
  const gone = new Set(deleted.map((d) => d.styleCode));
  const lines = flips.map((f) => `  - ${f.styleCode}: ${f.variants} variants, ${f.qty} units in the DB${gone.has(f.styleCode) ? "  [deleted in Shopify -> marked DELETED_BY_VENDOR, never auto-recreated]" : "  [unlisted/archived/retitled]"}`);
  const rem = removedVariants.length
    ? `\n\n${removedVariants.length} variant(s) were deleted from products that are still live (the push skips them every cycle until recorded):\n${removedVariants.slice(0, 30).map((r) => `  - ${r.sku}`).join("\n")}\nRecord them so nothing recreates them: npm run vendor-deletions -- --execute`
    : "";
  return (
    `${flips.length} product(s) went from on-Shopify to NOT on Shopify at the last relink:\n\n${lines.join("\n")}${rem}\n\n` +
    "If this was not intentional, restore them in Shopify admin. If the vendor deleted them on purpose and never wants them, ask him to unfavorite them on Kelme."
  );
}

export function verifyMismatchAlertBody(total: number, sample: { sku: string; expectedQty: number; actualOnHand: number | null }[]): string {
  const lines = sample.slice(0, 15).map((m) => `  - ${m.sku}: Kelme/DB ${m.expectedQty}, Shopify ${m.actualOnHand ?? "no level"}`);
  return `${total} variants differ between the DB and Shopify after this cycle's push (threshold ${VERIFY_MISMATCH_ALERT_THRESHOLD}). First ${lines.length}:\n\n${lines.join("\n")}`;
}

export interface NewVariant {
  styleCode: string;
  colorCode: string;
  shopifySize: string;
  qty: number;
}

/** Kelme variants (new color/size on a live product) the DB doesn't have, grouped per style with the exact add command. */
export function newVariantGroups(unmatched: NewVariant[]): { styleCode: string; sizes: string[]; variants: NewVariant[]; command: string }[] {
  const by = new Map<string, NewVariant[]>();
  for (const u of unmatched) {
    if (!by.has(u.styleCode)) by.set(u.styleCode, []);
    by.get(u.styleCode)!.push(u);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([styleCode, variants]) => {
      const sizes = [...new Set(variants.map((v) => v.shopifySize))];
      return { styleCode, sizes, variants, command: `npm run sizes -- add-sizes --styleCode ${styleCode} --sizes ${sizes.join(",")}` };
    });
}

export function newVariantAlertBody(unmatched: NewVariant[]): string {
  const groups = newVariantGroups(unmatched);
  const blocks = groups.map((g) => `${g.styleCode}\n${g.variants.map((v) => `  + color ${v.colorCode}, size ${v.shopifySize}, Kelme qty ${v.qty}`).join("\n")}\n  dry-run: ${g.command}\n  apply:   ${g.command} --execute   (stop the Railway worker first)`);
  return (
    `Kelme now offers ${unmatched.length} color/size combination(s) on live products that are not in the DB or on Shopify. ` +
    "Nothing was added automatically.\n\n" +
    blocks.join("\n\n") +
    "\n\nIf the vendor deleted a color/size on purpose, it is recorded with `npm run vendor-deletions -- --execute` and never shows up here."
  );
}
