// Shared SKU builder — the join key between Kelme variants and Shopify
// variants. Format is locked: styleCode-colorCode-shopifySize.
// shopifySize is the Shopify-facing size (EU numeric for kids, KELME
// letters for adults) — never the raw Kelme cm size. Must be identical on
// the stamp side and the sync side.
export function buildSku(styleCode: string, colorCode: string, shopifySize: string): string {
  return `${styleCode}-${colorCode}-${shopifySize}`;
}
