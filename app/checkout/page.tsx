"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useCart } from "@/components/CartProvider";

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export default function CheckoutPage() {
  const router = useRouter();
  const { items, totalUnits, itemsTotal, clear } = useCart();
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerNote, setCustomerNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: items.map(({ productId, styleCode, name, color, size, qty, unitPrice }) => ({
          productId,
          styleCode,
          name,
          color,
          size,
          qty,
          unitPrice,
        })),
        customerName,
        customerEmail,
        customerNote,
      }),
    });

    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setError(data.error ?? "Checkout failed");
      return;
    }

    clear();
    router.push(`/order/${data.order.id}`);
  }

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center sm:px-6">
        <p className="text-sm text-neutral-500">
          Your cart is empty.{" "}
          <Link href="/shop" className="text-ink underline underline-offset-2">
            Browse the catalog
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-10 sm:px-6">
      <h1 className="font-display font-bold text-3xl uppercase tracking-wide text-ink">Checkout</h1>
      <p className="mt-1 text-sm text-neutral-500">
        {totalUnits} units · {formatPrice(itemsTotal)} subtotal.
      </p>
      <p className="mt-4 rounded-md border border-line bg-surface px-3 py-2 text-xs text-neutral-500">
        Simulated checkout — this creates an order and a placeholder payment link. No charge is made
        and nothing is sent to Kelme.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm text-neutral-600">
          Name
          <input
            required
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
            className="rounded-md border border-line bg-white px-3 py-2 text-ink focus:border-ink focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-neutral-600">
          Email
          <input
            required
            type="email"
            value={customerEmail}
            onChange={(e) => setCustomerEmail(e.target.value)}
            className="rounded-md border border-line bg-white px-3 py-2 text-ink focus:border-ink focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-neutral-600">
          Order note (optional)
          <textarea
            value={customerNote}
            onChange={(e) => setCustomerNote(e.target.value)}
            rows={3}
            className="rounded-md border border-line bg-white px-3 py-2 text-ink focus:border-ink focus:outline-none"
          />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={loading}
          className="font-display mt-2 rounded-full bg-ink px-4 py-3 uppercase tracking-wide text-paper transition-colors hover:bg-neutral-800 disabled:opacity-50"
        >
          {loading ? "Placing order…" : "Place order"}
        </button>
      </form>
    </div>
  );
}
