"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { StoreProduct } from "@/lib/types";
import { summarizeColorAvailability } from "@/lib/availability";
import { getProductColorNames } from "@/lib/colors";
import { swatchColor } from "@/lib/swatch";
import { useProductColor } from "./ProductColorContext";

const LEVEL_STYLES: Record<string, string> = {
  "in-stock": "text-emerald-700",
  "low-stock": "text-amber-600",
  "made-to-order": "text-neutral-400",
};

// Catalog-level stock peek: per-color availability at a glance, derived from
// the same parsed sku-sheet stock as the product page — summarized per
// color, not broken out by size (the size grid stays on the product page).
// Rendered via portal so it's detached from the card's <Link> DOM subtree —
// clicks inside can't accidentally trigger the card's navigation. Only ever
// mounted client-side (after the info button's onClick), so document.body
// is always available — no SSR guard needed.
export function ColorAvailabilityModal({ product, onClose }: { product: StoreProduct; onClose: () => void }) {
  const { selectedColor } = useProductColor();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const colorNames = getProductColorNames(product);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Color availability for ${product.name}`}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-xl border border-line bg-white p-5 shadow-xl"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-sm uppercase tracking-wide text-ink">{product.name}</h2>
            <p className="text-xs text-neutral-400">{product.styleCode}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-neutral-400 hover:text-ink"
          >
            ✕
          </button>
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
      </div>
    </div>,
    document.body,
  );
}
