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
      className={`font-display absolute left-2 top-2 rounded-full px-2 py-0.5 text-[9px] uppercase tracking-wide sm:left-3 sm:top-3 sm:px-2.5 sm:py-1 sm:text-[10px] ${
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
            className={`h-3.5 w-3.5 shrink-0 rounded-full ring-1 ring-offset-1 transition-transform sm:h-4 sm:w-4 ${
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
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-line text-[9px] text-neutral-500 hover:border-ink hover:text-ink sm:h-5 sm:w-5 sm:text-[10px]"
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

        <div className="flex flex-col gap-1 pt-2 sm:gap-1.5 sm:pt-3">
          <span className="font-display line-clamp-2 min-h-7.5 text-xs uppercase tracking-wide leading-tight text-ink sm:min-h-8.75 sm:text-sm">
            {product.name}
          </span>

          <div className="flex items-baseline gap-1.5 sm:gap-2">
            {finalPrice != null ? (
              <>
                <span className="font-display text-sm text-ink sm:text-base">{formatPrice(finalPrice)}</span>
                {hasDiscount && product.sellPrice != null && (
                  <span className="text-[11px] text-neutral-400 line-through sm:text-xs">
                    {formatPrice(product.sellPrice)}
                  </span>
                )}
              </>
            ) : (
              <span className="text-xs text-neutral-400 sm:text-sm">Price not set</span>
            )}
          </div>

          <div className="mt-0.5 flex min-h-4 items-center justify-between gap-2 sm:min-h-5">
            {colorNames.length > 0 && (
              <>
                <CardSwatches colors={colorNames} />
                <CardInfoButton product={product} />
              </>
            )}
          </div>
        </div>
      </Link>
    </ProductColorProvider>
  );
}
