"use client";

import type { StoreProduct } from "@/lib/types";
import { getUnitPrice } from "@/lib/price";
import { Modal } from "./Modal";
import { ProductView } from "./ProductView";

// Compact quick-add, opened from the catalog card's "+" button.
export function ProductQuickAddModal({ product, onClose }: { product: StoreProduct; onClose: () => void }) {
  const { unitPrice } = getUnitPrice(product);

  return (
    <Modal onClose={onClose} label={`Quick add ${product.name}`} maxWidth="max-w-2xl">
      <ProductView product={product} unitPrice={unitPrice} mode="compact" />
    </Modal>
  );
}
