import { getOrders } from "@/lib/orders";
import { AdminOrderList } from "@/components/admin/AdminOrderList";

export default async function AdminOrdersPage() {
  const orders = await getOrders();

  return (
    <div>
      <h2 className="mb-4 font-display text-xl uppercase tracking-wide text-ink">Orders</h2>
      <AdminOrderList
        orders={orders.map((o) => ({
          ...o,
          createdAt: o.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
