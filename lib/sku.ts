// Shared SKU builder — the join key between Kelme variants and Shopify
// variants. Format is locked: styleCode-colorCode-shopifySize.
// shopifySize is the Shopify-facing size (EU numeric for kids, KELME
// letters for adults) — never the raw Kelme cm size. Must be identical on
// the stamp side and the sync side.
//
// "One Size" is the canonical shopifySize for equipment with no Shopify
// Size option (balls, socks, backpacks, bibs, armbands, agility gear) —
// but a space isn't safe inside a SKU token, so it's spelled ONE_SIZE_SKU_TOKEN
// there. lib/shopify-relink.ts's parser must substitute the same "One Size"
// shopifySize value (not this token) when matching, since matching keys off
// the raw field, not the built SKU string.
export const ONE_SIZE = "One Size";
export const ONE_SIZE_SKU_TOKEN = "OS";

export function buildSku(styleCode: string, colorCode: string, shopifySize: string): string {
  const sizeToken = shopifySize === ONE_SIZE ? ONE_SIZE_SKU_TOKEN : shopifySize;
  return `${styleCode}-${colorCode}-${sizeToken}`;
}
