"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { StoreProduct } from "@/lib/types";
import { formatPrice } from "@/lib/price";
import { sizeSortKey } from "@/lib/size-sort";
import { getProductColorNames } from "@/lib/colors";
import { getSizeStatus } from "@/lib/size-availability";
import { useCart } from "./CartProvider";
import { useProductColor } from "./ProductColorContext";
import { ProductColorImage } from "./ProductColorImage";
import { ProductImage } from "./ProductImage";
import { ColorSwatches } from "./ColorSwatches";
import { SizeGrid } from "./SizeGrid";
import { QuantityStepper } from "./QuantityStepper";
import { Accordion, AccordionItem } from "./Accordion";

// One selection UI, two layouts: "full" is the standalone product page,
// "compact" is the catalog quick-add modal. Both share the same color
// (ProductColorContext), size, quantity, and add-to-cart state — only the
// arrangement of that state on screen differs.
export function ProductView({
  product,
  unitPrice,
  mode,
}: {
  product: StoreProduct;
  unitPrice: number | null;
  mode: "full" | "compact";
}) {
  const { addItems } = useCart();
  const { selectedColor, setSelectedColor } = useProductColor();
  const [selectedSize, setSelectedSize] = useState("");
  const [qty, setQty] = useState(1);
  const [confirmed, setConfirmed] = useState(false);

  const colorNames = getProductColorNames(product);
  const selectedSizeStatus = selectedSize ? getSizeStatus(product.stock, selectedColor, selectedSize) : null;

  const sizesForColor = useMemo(() => {
    return product.stock
      .filter((s) => s.color === selectedColor)
      .map((e) => e.size)
      .sort((a, b) => sizeSortKey(a)[0] - sizeSortKey(b)[0] || a.localeCompare(b));
  }, [product.stock, selectedColor]);

  // Reset size/qty whenever the shopper switches colors — adjusted during
  // render (React's recommended pattern for resetting state off a prop
  // change) rather than in an effect, to avoid an extra render.
  const [renderedColor, setRenderedColor] = useState(selectedColor);
  if (selectedColor !== renderedColor) {
    setRenderedColor(selectedColor);
    setSelectedSize(sizesForColor[0] ?? "");
    setQty(1);
    setConfirmed(false);
  }
  // Default to the first size once sizes for the initial color resolve.
  if (!selectedSize && sizesForColor.length > 0) {
    setSelectedSize(sizesForColor[0]);
  }

  function handleAddToCart() {
    if (unitPrice == null || !selectedSize) return;
    const colorCode = product.stock.find((s) => s.color === selectedColor)?.colorCode ?? "";
    addItems([
      {
        productId: product.id,
        styleCode: product.styleCode,
        name: product.name,
        imageUrl: product.imageUrl,
        color: selectedColor,
        colorCode,
        size: selectedSize,
        qty,
        unitPrice,
      },
    ]);
    setConfirmed(true);
  }

  const canAddToCart = unitPrice != null && Boolean(selectedSize);
  const addToCartLabel = unitPrice == null ? "Price not set" : confirmed ? "Added ✓" : "Add to Cart";

  const inlineAddToCartRef = useRef<HTMLDivElement>(null);
  const [showStickyFooter, setShowStickyFooter] = useState(false);

  useEffect(() => {
    if (mode !== "full") return;
    const el = inlineAddToCartRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setShowStickyFooter(!entry.isIntersecting), {
      rootMargin: "-1px 0px 0px 0px",
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [mode]);

  const addToCartButton = (
    <button
      type="button"
      disabled={!canAddToCart}
      onClick={handleAddToCart}
      className="font-display flex items-center justify-center gap-2 rounded-full bg-ink px-6 py-2.5 text-sm uppercase tracking-wide text-paper transition-colors hover:bg-neutral-800 disabled:cursor-not-allowed disabled:bg-neutral-300"
    >
      {addToCartLabel}
    </button>
  );

  // Gallery thumbnails: one per color that has its own photo, deduped by
  // image URL so colors sharing the mainpic fallback don't repeat it.
  const thumbnails = useMemo(() => {
    const seen = new Set<string>();
    return colorNames.reduce<{ color: string; image: string }[]>((acc, name) => {
      const colorCode = product.stock.find((s) => s.color === name)?.colorCode;
      const image = (colorCode && product.colorImages[colorCode]) || product.imageUrl;
      if (!image || seen.has(image)) return acc;
      seen.add(image);
      acc.push({ color: name, image });
      return acc;
    }, []);
  }, [colorNames, product.stock, product.colorImages, product.imageUrl]);

  const gallery = (
    <div>
      <div className="relative overflow-hidden rounded-xl bg-surface">
        <ProductColorImage product={product} className="aspect-square w-full" />
      </div>
      {mode === "full" && thumbnails.length > 1 && (
        <div className="mt-3 flex gap-2 overflow-x-auto">
          {thumbnails.map((t) => (
            <button
              key={t.image}
              type="button"
              onClick={() => setSelectedColor(t.color)}
              aria-label={`View ${t.color}`}
              aria-pressed={t.color === selectedColor}
              className={`h-16 w-16 shrink-0 overflow-hidden rounded-lg border transition-colors ${
                t.color === selectedColor ? "border-ink" : "border-line hover:border-neutral-400"
              }`}
            >
              <ProductImage src={t.image} alt={t.color} className="h-full w-full" />
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const titleBlock = (
    <div>
      <p className="text-xs text-neutral-400">Sku: {product.styleCode}</p>
      <h1
        className={`font-display font-bold uppercase tracking-wide text-ink ${
          mode === "full" ? "text-3xl sm:text-4xl" : "text-xl"
        }`}
      >
        {product.name}
      </h1>
    </div>
  );

  const priceBlock = (
    <div className="flex items-baseline gap-2">
      {unitPrice != null ? (
        <span className="font-display text-2xl text-ink">{formatPrice(unitPrice)}</span>
      ) : (
        <span className="text-base text-neutral-400">Price not set</span>
      )}
    </div>
  );

  const colorBlock =
    colorNames.length > 0 ? (
      <div>
        <p className="font-display mb-2 text-xs uppercase tracking-wide text-ink">
          Color: <span className="text-neutral-500">{selectedColor}</span>
        </p>
        <ColorSwatches colors={colorNames} />
      </div>
    ) : null;

  const sizeBlock = (
    <div className="flex flex-col gap-2">
      <SizeGrid stock={product.stock} color={selectedColor} selectedSize={selectedSize} onSelect={setSelectedSize} />
      {selectedSizeStatus === "made-to-order" && (
        <p className="font-display text-xs uppercase tracking-wide text-amber-600">
          Made to order — this size ships after production
        </p>
      )}
    </div>
  );

  if (mode === "compact") {
    return (
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-[minmax(0,320px)_1fr]">
        {gallery}
        <div className="flex flex-col gap-4">
          {titleBlock}
          {priceBlock}
          <div className="flex items-center gap-3">
            <QuantityStepper qty={qty} onChange={setQty} size="sm" />
            {addToCartButton}
          </div>
          {colorBlock}
          {sizeBlock}
          <Link
            href={`/product/${encodeURIComponent(product.styleCode)}`}
            className="font-display inline-flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink hover:text-neutral-600"
          >
            View full details →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-8 sm:grid-cols-[400px_1fr]">
        {gallery}
        <div className="flex flex-col justify-center gap-4">
          {titleBlock}
          {priceBlock}
          <div ref={inlineAddToCartRef} className="flex items-center gap-3">
            <QuantityStepper qty={qty} onChange={setQty} />
            {addToCartButton}
          </div>
          {colorBlock}
          {sizeBlock}
          <p className="text-xs text-neutral-400">
            Inventory last synced{" "}
            {product.stockSyncedAt
              ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(
                  new Date(product.stockSyncedAt),
                )
              : "not yet synced"}
          </p>

          <Accordion>
            <AccordionItem title="Description">
              <p>Product description coming soon.</p>
            </AccordionItem>
            <AccordionItem title="Reviews">
              <p>No reviews yet.</p>
            </AccordionItem>
            <AccordionItem title="Terms and conditions">
              <p>Standard terms apply. Details coming soon.</p>
            </AccordionItem>
          </Accordion>
        </div>
      </div>

      {showStickyFooter && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white/95 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-surface">
                <ProductColorImage product={product} className="h-full w-full" />
              </div>
              <div className="min-w-0">
                <p className="font-display truncate text-sm uppercase tracking-wide text-ink">{product.name}</p>
                <p className="truncate text-xs text-neutral-500">
                  {selectedColor}
                  {selectedSize ? ` / ${selectedSize}` : ""}
                  {unitPrice != null ? ` — ${formatPrice(unitPrice)}` : ""}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <QuantityStepper qty={qty} onChange={setQty} size="sm" />
              {addToCartButton}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
