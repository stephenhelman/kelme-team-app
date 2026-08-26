"use client";

import { useMemo, useState } from "react";
import type { StoreProduct } from "@/lib/types";
import { getAvailability } from "@/lib/availability";
import { useCart } from "./CartProvider";
import { useProductColor } from "./ProductColorContext";

// Natural sort so sizes read like a kit sheet (S, M, L, XL, 2XL...) rather
// than alphabetically (2XL before L).
function sizeSortKey(size: string): [number, string] {
  const match = size.match(/^(\d+)?\s*(X*S|X*L|M)?$/i);
  if (match) {
    const multiplier = match[1] ? parseInt(match[1], 10) : 1;
    const base = (match[2] ?? "").toUpperCase();
    const xCount = (base.match(/X/g) ?? []).length;
    if (base.endsWith("S")) return [0 - xCount, size];
    if (base.endsWith("L")) return [2 + xCount * multiplier, size];
    if (base === "M") return [1, size];
  }
  const cmMatch = size.match(/^(\d+)\s*cm$/i);
  if (cmMatch) return [10 + Number(cmMatch[1]), size];
  const numeric = Number(size);
  if (!Number.isNaN(numeric)) return [10 + numeric, size];
  return [999, size];
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

// Size/stock grid for whatever color is currently selected (shared state
// from ProductColorProvider) — the image and the swatches above derive from
// the same selection.
export function KitSelector({ product, unitPrice }: { product: StoreProduct; unitPrice: number | null }) {
  const { addItems } = useCart();
  const { selectedColor } = useProductColor();
  const [qtyBySize, setQtyBySize] = useState<Record<string, number>>({});
  const [confirmed, setConfirmed] = useState(false);

  // Reset in-progress size quantities whenever the shopper switches colors —
  // adjusted during render (React's recommended pattern for resetting state
  // off a prop change) rather than in an effect, to avoid an extra render.
  const [renderedColor, setRenderedColor] = useState(selectedColor);
  if (selectedColor !== renderedColor) {
    setRenderedColor(selectedColor);
    setQtyBySize({});
    setConfirmed(false);
  }

  const sizesForColor = useMemo(() => {
    const entries = product.stock.filter((s) => s.color === selectedColor);
    return entries
      .map((e) => ({ size: e.size, qty: e.qty }))
      .sort((a, b) => sizeSortKey(a.size)[0] - sizeSortKey(b.size)[0] || a.size.localeCompare(b.size));
  }, [product.stock, selectedColor]);

  function setQty(size: string, qty: number) {
    setConfirmed(false);
    setQtyBySize((prev) => ({ ...prev, [size]: Math.max(0, qty) }));
  }

  const selectedTotal = Object.values(qtyBySize).reduce((sum, q) => sum + q, 0);

  function handleAddToCart() {
    if (unitPrice == null || selectedTotal === 0) return;
    const colorCode = product.stock.find((s) => s.color === selectedColor)?.colorCode ?? "";

    addItems(
      Object.entries(qtyBySize)
        .filter(([, qty]) => qty > 0)
        .map(([size, qty]) => ({
          productId: product.id,
          styleCode: product.styleCode,
          name: product.name,
          imageUrl: product.imageUrl,
          color: selectedColor,
          colorCode,
          size,
          qty,
          unitPrice,
        })),
    );

    setQtyBySize({});
    setConfirmed(true);
  }

  return (
    <div className="rounded-xl border border-line bg-white">
      <div className="p-5">
        {sizesForColor.length === 0 ? (
          <p className="text-sm text-neutral-500">
            Size-level stock not yet synced for this colorway — contact the vendor to order.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
            {sizesForColor.map(({ size, qty }) => {
              const availability = getAvailability(qty);
              return (
                <div
                  key={size}
                  className="flex flex-col items-center gap-1.5 rounded-lg border border-line bg-surface p-2.5"
                >
                  <span className="font-display text-lg leading-none text-ink">{size}</span>
                  <span
                    className={`font-display text-[10px] uppercase leading-none tracking-wide ${
                      availability.level === "in-stock"
                        ? "text-emerald-700"
                        : availability.level === "low-stock"
                          ? "text-amber-600"
                          : "text-neutral-400"
                    }`}
                  >
                    {availability.label}
                  </span>
                  <input
                    type="number"
                    min={0}
                    value={qtyBySize[size] ?? 0}
                    onChange={(e) => setQty(size, Number(e.target.value) || 0)}
                    className="w-full rounded border border-line bg-white px-1.5 py-1 text-center text-sm text-ink focus:border-ink focus:outline-none"
                    aria-label={`Quantity for size ${size}`}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line p-5">
        <span className="text-sm text-neutral-500">
          {selectedTotal > 0
            ? `${selectedTotal} unit${selectedTotal === 1 ? "" : "s"} selected${
                unitPrice != null ? ` · ${formatPrice(selectedTotal * unitPrice)}` : ""
              }`
            : "Set a quantity per size to add to cart"}
        </span>
        <button
          type="button"
          disabled={unitPrice == null || selectedTotal === 0}
          onClick={handleAddToCart}
          className="font-display rounded-full bg-ink px-6 py-2.5 text-sm uppercase tracking-wide text-paper transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-300"
        >
          {unitPrice == null ? "Price not set" : confirmed ? "Added ✓" : "Add to cart"}
        </button>
      </div>
    </div>
  );
}
