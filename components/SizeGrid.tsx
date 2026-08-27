"use client";

import { useMemo } from "react";
import type { StockEntry } from "@/lib/types";
import { getAllSizes, getSizeStatus } from "@/lib/size-availability";

// Single-select size grid, sized against the product's full size run (union
// across colors) so a size the current color doesn't carry still shows —
// grayed out and unselectable — rather than silently disappearing. In-stock
// and made-to-order sizes both stay selectable; only a true gap in this
// color's size run is a gate (see lib/size-availability.ts).
export function SizeGrid({
  stock,
  color,
  selectedSize,
  onSelect,
}: {
  stock: StockEntry[];
  color: string;
  selectedSize: string;
  onSelect: (size: string) => void;
}) {
  const allSizes = useMemo(() => getAllSizes(stock), [stock]);

  if (allSizes.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        Size-level stock not yet synced for this colorway — contact the vendor to order.
      </p>
    );
  }

  return (
    <div>
      <p className="font-display mb-2 text-xs uppercase tracking-wide text-ink">
        Size: <span className="text-neutral-500">{selectedSize || "Select"}</span>
      </p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Size">
        {allSizes.map((size) => {
          const status = getSizeStatus(stock, color, size);
          const selected = size === selectedSize;
          const unavailable = status === "unavailable";
          return (
            <button
              key={size}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={unavailable}
              disabled={unavailable}
              onClick={() => !unavailable && onSelect(size)}
              title={unavailable ? "Out of stock" : undefined}
              className={`font-display group relative min-w-11 rounded-md border px-3 py-2 text-sm uppercase tracking-wide transition-colors ${
                selected
                  ? "border-ink bg-ink text-paper"
                  : unavailable
                    ? "cursor-not-allowed border-line text-neutral-300"
                    : "border-line text-ink hover:border-ink"
              }`}
            >
              {size}
              {unavailable && (
                <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-neutral-300" />
              )}
              {unavailable && (
                <span
                  role="tooltip"
                  className="pointer-events-none absolute left-1/2 top-full z-10 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-ink px-2 py-1 text-[10px] normal-case tracking-normal text-paper opacity-0 transition-opacity group-hover:opacity-100"
                >
                  Out of stock
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
