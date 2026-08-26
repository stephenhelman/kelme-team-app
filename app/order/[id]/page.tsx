import { notFound } from "next/navigation";
import Link from "next/link";
import { getOrderById } from "@/lib/orders";

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export default async function OrderConfirmationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const order = await getOrderById(Number(id));
  if (!order) notFound();

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <p className="font-display text-sm uppercase tracking-wide text-emerald-700">Order placed</p>
      <h1 className="font-display mt-1 text-3xl font-bold uppercase tracking-wide text-ink sm:text-4xl">
        Order #{order.id}
      </h1>

      <p className="mt-4 rounded-md border border-line bg-surface px-3 py-2 text-xs text-neutral-500">
        This is a simulated confirmation — the payment link below is a placeholder, no charge has
        been made, and no order was sent to Kelme.
      </p>

      <div className="mt-6 rounded-xl border border-line bg-white p-5">
        <div className="flex flex-col gap-2">
          {order.items.map((item) => (
            <div key={item.id} className="flex justify-between text-sm text-neutral-600">
              <span>
                {item.qty}× {item.name} — {item.color} / {item.size}
              </span>
              <span>{formatPrice(item.qty * item.unitPrice)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex justify-between border-t border-line pt-3 text-sm text-neutral-600">
          <span>Units</span>
          <span>{order.unitCount}</span>
        </div>
        <div className="mt-1 flex justify-between text-sm text-neutral-600">
          <span>Shipping</span>
          <span>{formatPrice(order.shippingTotal)}</span>
        </div>
        <div className="font-display mt-3 flex justify-between border-t border-line pt-3 text-lg text-ink">
          <span>Total</span>
          <span>{formatPrice(order.orderTotal)}</span>
        </div>
      </div>

      <div className="mt-6 rounded-xl border border-line bg-surface p-5">
        <p className="text-xs uppercase tracking-wide text-neutral-400">Placeholder payment link</p>
        <p className="mt-1 break-all font-mono text-sm text-ink">{order.paymentLink}</p>
      </div>

      <Link href="/shop" className="mt-8 inline-block text-sm text-neutral-500 hover:text-ink">
        ← Back to catalog
      </Link>
    </div>
  );
}
