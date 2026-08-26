"use client";

import { useState } from "react";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/orders";

interface OrderItem {
  id: number;
  name: string;
  color: string;
  size: string;
  qty: number;
  unitPrice: number;
}

interface Order {
  id: number;
  status: string;
  unitCount: number;
  shippingTotal: number;
  orderTotal: number;
  paymentLink: string;
  customerName: string;
  customerEmail: string;
  customerNote: string;
  createdAt: string;
  items: OrderItem[];
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function OrderCard({ order }: { order: Order }) {
  const [status, setStatus] = useState(order.status);
  const [resent, setResent] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function handleStatusChange(next: string) {
    setStatus(next);
    await fetch(`/api/admin/orders/${order.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
  }

  async function handleResend() {
    await fetch(`/api/admin/orders/${order.id}/resend`, { method: "POST" });
    setResent(true);
    setTimeout(() => setResent(false), 2000);
  }

  return (
    <div className="rounded-xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="font-display text-sm uppercase tracking-wide text-ink hover:text-neutral-600"
        >
          Order #{order.id} {expanded ? "▾" : "▸"}
        </button>
        <span className="text-xs text-neutral-400">
          {order.customerName} · {order.unitCount} units · {formatPrice(order.orderTotal)}
        </span>

        <select
          value={status}
          onChange={(e) => handleStatusChange(e.target.value)}
          className="ml-auto rounded border border-line bg-white px-2 py-1 text-xs capitalize text-ink focus:border-ink focus:outline-none"
        >
          {ORDER_STATUSES.map((s: OrderStatus) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={handleResend}
          className="rounded border border-line px-2 py-1 text-xs text-neutral-500 hover:border-ink hover:text-ink"
        >
          {resent ? "Sent (simulated) ✓" : "Resend notification"}
        </button>
      </div>

      {expanded && (
        <div className="mt-3 border-t border-line pt-3 text-sm text-neutral-600">
          <p className="text-xs text-neutral-400">
            {order.customerEmail} · {new Date(order.createdAt).toLocaleString()}
          </p>
          {order.customerNote && <p className="mt-1 text-xs text-neutral-500">Note: {order.customerNote}</p>}
          <div className="mt-2 flex flex-col gap-1">
            {order.items.map((item) => (
              <div key={item.id} className="flex justify-between text-xs">
                <span>
                  {item.qty}× {item.name} — {item.color} / {item.size}
                </span>
                <span>{formatPrice(item.qty * item.unitPrice)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 break-all text-xs text-neutral-400">Payment link: {order.paymentLink}</p>
        </div>
      )}
    </div>
  );
}

export function AdminOrderList({ orders }: { orders: Order[] }) {
  if (orders.length === 0) {
    return <p className="text-sm text-neutral-500">No orders yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {orders.map((order) => (
        <OrderCard key={order.id} order={order} />
      ))}
    </div>
  );
}
