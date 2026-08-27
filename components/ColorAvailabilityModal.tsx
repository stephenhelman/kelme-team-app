"use client";

import type { StoreProduct } from "@/lib/types";
import { summarizeColorAvailability } from "@/lib/availability";
import { getProductColorNames } from "@/lib/colors";
import { swatchColor } from "@/lib/swatch";
import { useProductColor } from "./ProductColorContext";
import { Modal } from "./Modal";

const LEVEL_STYLES: Record<string, string> = {
  "in-stock": "text-emerald-700",
  "low-stock": "text-amber-600",
  "made-to-order": "text-neutral-400",
};

// Catalog-level stock peek: per-color availability at a glance, derived from
// the same parsed sku-sheet stock as the product page — summarized per
// color, not broken out by size (the size grid stays on the product page).
export function ColorAvailabilityModal({ product, onClose }: { product: StoreProduct; onClose: () => void }) {
  const { selectedColor } = useProductColor();
  const colorNames = getProductColorNames(product);

  return (
    <Modal onClose={onClose} label={`Color availability for ${product.name}`}>
      <div className="mb-3 pr-6">
        <h2 className="font-display text-sm uppercase tracking-wide text-ink">{product.name}</h2>
        <p className="text-xs text-neutral-400">{product.styleCode}</p>
      </div>

      <div className="flex flex-col gap-1">
        {colorNames.map((color) => {
          const entries = product.stock.filter((s) => s.color === color);
          const availability = summarizeColorAvailability(entries.map((e) => e.qty));
          const isSelected = color === selectedColor;
          return (
            <div
              key={color}
              className={`flex items-center justify-between rounded-md px-2 py-1.5 ${
                isSelected ? "bg-surface ring-1 ring-ink/10" : ""
              }`}
            >
              <span className="flex items-center gap-2 text-sm text-ink">
                <span
                  className="h-3 w-3 rounded-full ring-1 ring-black/10"
                  style={{ backgroundColor: swatchColor(color) }}
                />
                {color}
              </span>
              <span className={`font-display text-xs uppercase tracking-wide ${LEVEL_STYLES[availability.level]}`}>
                {availability.label}
              </span>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
