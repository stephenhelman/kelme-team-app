import { getAllProductsForAdmin } from "@/lib/products";
import { AdminProductTable } from "@/components/admin/AdminProductTable";
import { RefreshFromKelmeButton } from "@/components/admin/RefreshFromKelmeButton";

export default async function AdminProductsPage() {
  const products = await getAllProductsForAdmin();

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl uppercase tracking-wide text-ink">Pricing</h2>
          <p className="text-sm text-neutral-400">
            {products.length} product{products.length === 1 ? "" : "s"} from the seeded Kelme
            catalog. Kelme prices are reference only — set your own sell price to publish.
          </p>
        </div>
        <RefreshFromKelmeButton />
      </div>

      <AdminProductTable products={products} />
    </div>
  );
}
