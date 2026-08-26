"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useCart } from "@/components/CartProvider";
import { ProductImage } from "@/components/ProductImage";

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export default function CartPage() {
  const { items, removeItem, setItemQty, totalUnits, itemsTotal } = useCart();
  const [settings, setSettings] = useState<{ shippingPerUnit: number; minOrderUnits: number } | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then(setSettings)
      .catch(() => setSettings({ shippingPerUnit: 3, minOrderUnits: 25 }));
  }, []);

  const shippingTotal = settings ? totalUnits * settings.shippingPerUnit : 0;
  const orderTotal = itemsTotal + shippingTotal;
  const unitsShort = settings ? Math.max(0, settings.minOrderUnits - totalUnits) : 0;
  const meetsMinimum = settings ? totalUnits >= settings.minOrderUnits : false;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <h1 className="font-display font-bold text-3xl uppercase tracking-wide text-ink sm:text-4xl">Cart</h1>

      {items.length === 0 ? (
        <p className="mt-8 text-sm text-neutral-500">
          Your cart is empty.{" "}
          <Link href="/shop" className="text-ink underline underline-offset-2">
            Browse the catalog
          </Link>
          .
        </p>
      ) : (
        <>
          <div className="mt-6 flex flex-col gap-3">
            {items.map((item) => (
              <div
                key={item.key}
                className="flex items-center gap-4 rounded-xl border border-line bg-white p-3"
              >
                <ProductImage src={item.imageUrl} alt={item.name} className="h-16 w-16 rounded-lg" />
                <div className="min-w-0 flex-1">
                  <p className="font-display truncate text-sm uppercase tracking-wide text-ink">
                    {item.name}
                  </p>
                  <p className="text-xs text-neutral-400">
                    {item.styleCode} · {item.color} · {item.size}
                  </p>
                  <p className="text-xs text-neutral-400">{formatPrice(item.unitPrice)} / unit</p>
                </div>
                <input
                  type="number"
                  min={0}
                  value={item.qty}
                  onChange={(e) => setItemQty(item.key, Number(e.target.value) || 0)}
                  className="w-16 rounded border border-line bg-white px-2 py-1 text-center text-sm text-ink focus:border-ink focus:outline-none"
                  aria-label={`Quantity for ${item.name} ${item.color} ${item.size}`}
                />
                <span className="w-20 text-right text-sm text-ink">
                  {formatPrice(item.qty * item.unitPrice)}
                </span>
                <button
                  type="button"
                  onClick={() => removeItem(item.key)}
                  className="text-neutral-400 hover:text-red-600"
                  aria-label={`Remove ${item.name} ${item.color} ${item.size}`}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <div className="mt-8 rounded-xl border border-line bg-white p-5">
            <div className="flex justify-between text-sm text-neutral-500">
              <span>Units</span>
              <span>{totalUnits}</span>
            </div>
            <div className="mt-1 flex justify-between text-sm text-neutral-500">
              <span>Items subtotal</span>
              <span>{formatPrice(itemsTotal)}</span>
            </div>
            <div className="mt-1 flex justify-between text-sm text-neutral-500">
              <span>Shipping ({formatPrice(settings?.shippingPerUnit ?? 3)}/unit)</span>
              <span>{formatPrice(shippingTotal)}</span>
            </div>
            <div className="font-display mt-3 flex justify-between border-t border-line pt-3 text-lg text-ink">
              <span>Total</span>
              <span>{formatPrice(orderTotal)}</span>
            </div>

            {!meetsMinimum && settings && (
              <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                Minimum order is {settings.minOrderUnits} units — add {unitsShort} more to check out.
              </p>
            )}

            <Link
              href={meetsMinimum ? "/checkout" : "#"}
              aria-disabled={!meetsMinimum}
              className={`font-display mt-4 block w-full rounded-full px-4 py-3 text-center uppercase tracking-wide transition-colors ${
                meetsMinimum
                  ? "bg-ink text-paper hover:bg-neutral-800"
                  : "pointer-events-none bg-neutral-100 text-neutral-400"
              }`}
            >
              Checkout
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
