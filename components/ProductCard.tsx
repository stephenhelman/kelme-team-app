"use client";

import { useState } from "react";
import Link from "next/link";
import type { StoreProduct } from "@/lib/types";
import { swatchColor } from "@/lib/swatch";
import { getProductColorNames } from "@/lib/colors";
import { getStockPill } from "@/lib/availability";
import { ProductColorProvider, useProductColor } from "./ProductColorContext";
import { ProductColorImage } from "./ProductColorImage";
import { ColorAvailabilityModal } from "./ColorAvailabilityModal";

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

// preventDefault + stopPropagation on every control here: these buttons sit
// inside the card's <Link> (so the rest of the card stays click-to-open),
// and must never trigger that link's navigation.
function stopLinkNavigation(e: React.MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
}

function StockPillBadge({ product }: { product: StoreProduct }) {
  const pill = getStockPill(product.stock.map((s) => s.qty));
  return (
    <span
      className={`font-display absolute left-3 top-3 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wide ${
        pill.level === "in-stock" ? "bg-white text-ink" : "bg-white/90 text-neutral-500"
      }`}
    >
      {pill.label}
    </span>
  );
}

function CardSwatches({ colors }: { colors: string[] }) {
  const { selectedColor, setSelectedColor } = useProductColor();

  return (
    <div className="flex items-center gap-1.5" aria-label={`${colors.length} colorways`}>
      {colors.slice(0, 6).map((color) => {
        const selected = color === selectedColor;
        return (
          <button
            key={color}
            type="button"
            title={color}
            aria-pressed={selected}
            onClick={(e) => {
              stopLinkNavigation(e);
              setSelectedColor(color);
            }}
            className={`h-4 w-4 shrink-0 rounded-full ring-1 ring-offset-1 transition-transform ${
              selected ? "scale-110 ring-ink ring-offset-white" : "ring-line ring-offset-white hover:scale-110"
            }`}
            style={{ backgroundColor: swatchColor(color) }}
          />
        );
      })}
      {colors.length > 6 && <span className="text-xs text-neutral-400">+{colors.length - 6}</span>}
    </div>
  );
}

function CardInfoButton({ product }: { product: StoreProduct }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          stopLinkNavigation(e);
          setOpen(true);
        }}
        aria-label={`View color availability for ${product.name}`}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-line text-[10px] text-neutral-500 hover:border-ink hover:text-ink"
      >
        i
      </button>
      {open && <ColorAvailabilityModal product={product} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ProductCard({ product }: { product: StoreProduct }) {
  const hasDiscount = product.discount != null && product.discount > 0 && product.sellPrice != null;
  const finalPrice =
    hasDiscount && product.sellPrice != null && product.discount != null
      ? product.sellPrice * (1 - product.discount / 100)
      : product.sellPrice;

  const colorNames = getProductColorNames(product);

  return (
    <ProductColorProvider initialColor={colorNames[0] ?? ""}>
      <Link href={`/product/${encodeURIComponent(product.styleCode)}`} className="group flex flex-col">
        <div className="relative overflow-hidden rounded-xl bg-surface">
          <ProductColorImage
            product={product}
            className="aspect-4/5 w-full transition-transform duration-300 group-hover:scale-[1.03]"
          />
          <StockPillBadge product={product} />
        </div>

        <div className="flex flex-col gap-1.5 pt-3">
          <span className="font-display text-sm uppercase tracking-wide leading-tight text-ink">
            {product.name}
          </span>

          <div className="flex items-baseline gap-2">
            {finalPrice != null ? (
              <>
                <span className="font-display text-base text-ink">{formatPrice(finalPrice)}</span>
                {hasDiscount && product.sellPrice != null && (
                  <span className="text-xs text-neutral-400 line-through">
                    {formatPrice(product.sellPrice)}
                  </span>
                )}
              </>
            ) : (
              <span className="text-sm text-neutral-400">Price not set</span>
            )}
          </div>

          {colorNames.length > 0 && (
            <div className="mt-0.5 flex items-center justify-between gap-2">
              <CardSwatches colors={colorNames} />
              <CardInfoButton product={product} />
            </div>
          )}
        </div>
      </Link>
    </ProductColorProvider>
  );
}
