import type { StoreProduct } from "./types";

export function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

// sellPrice/discount are vendor-set in admin; unitPrice is the discounted
// price shoppers actually pay, null when sellPrice hasn't been set yet.
export function getUnitPrice(product: StoreProduct): { unitPrice: number | null; hasDiscount: boolean } {
  const hasDiscount = product.discount != null && product.discount > 0 && product.sellPrice != null;
  const unitPrice =
    hasDiscount && product.sellPrice != null && product.discount != null
      ? product.sellPrice * (1 - product.discount / 100)
      : product.sellPrice;
  return { unitPrice, hasDiscount };
}
