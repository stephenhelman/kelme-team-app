"use client";

import type { StoreProduct } from "@/lib/types";
import { ProductImage } from "./ProductImage";
import { useProductColor } from "./ProductColorContext";

// Fallback order: color-specific photo (only if the seed's HEAD-check found
// one) -> product mainpic -> ProductImage's own placeholder on load failure.
// When we fall back to mainpic *because we know this color has no photo*
// (checked at seed time and confirmed missing, not just unchecked), flag it
// with a small overlay — otherwise a silently-wrong-color photo reads as a
// bug, not an intentional fallback.
export function ProductColorImage({ product, className }: { product: StoreProduct; className?: string }) {
  const { selectedColor } = useProductColor();
  const colorCode = product.stock.find((s) => s.color === selectedColor)?.colorCode;
  const colorImageChecked = colorCode != null && colorCode in product.colorImages;
  const hasColorImage = colorImageChecked && Boolean(product.colorImages[colorCode as string]);
  const src = (hasColorImage && product.colorImages[colorCode as string]) || product.imageUrl;
  const isFallback = colorImageChecked && !hasColorImage;

  return (
    <div className={`relative overflow-hidden ${className ?? ""}`}>
      <ProductImage src={src} alt={`${product.name} — ${selectedColor}`} className="h-full w-full" />
      {isFallback && (
        <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-200">
          Image not available
        </span>
      )}
    </div>
  );
}
