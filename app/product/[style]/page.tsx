import { notFound } from "next/navigation";
import Link from "next/link";
import { getCatalogProductByStyle } from "@/lib/catalog-cache";
import { getProductByStyle } from "@/lib/inventory-cache";
import { ProductImage } from "@/components/ProductImage";
import { VariantMatrix } from "@/components/VariantMatrix";

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export default async function ProductPage({
  params,
}: {
  params: Promise<{ style: string }>;
}) {
  const { style: styleParam } = await params;
  const style = decodeURIComponent(styleParam);

  const catalogProduct = await getCatalogProductByStyle(style);
  if (!catalogProduct) {
    notFound();
  }

  // Stock overlay: a join by styleCode against the raw inventory feed. Not
  // every favorited product has a match (equipment, accessories, etc.) —
  // that's fine, VariantMatrix falls back to the catalog's own color list.
  const stock = await getProductByStyle(style);
  const onSale = catalogProduct.discountPrice > 0 && catalogProduct.discountPrice < catalogProduct.price;

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 py-8">
      <Link href="/" className="text-sm text-neutral-400 hover:text-kit-400">
        ← Back to catalog
      </Link>

      <div className="mt-4 mb-8 grid grid-cols-1 gap-6 sm:grid-cols-[280px_1fr]">
        <ProductImage
          src={catalogProduct.image}
          alt={catalogProduct.name}
          className="aspect-square w-full rounded-lg"
        />

        <div className="flex flex-col justify-center gap-2">
          <h1 className="font-display text-3xl sm:text-4xl uppercase tracking-wide text-neutral-50">
            {catalogProduct.name}
          </h1>
          <p className="text-sm text-neutral-400">{catalogProduct.styleCode}</p>

          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-display text-2xl text-kit-400">
              {formatPrice(onSale ? catalogProduct.discountPrice : catalogProduct.price)}
            </span>
            {onSale && (
              <span className="text-sm text-neutral-500 line-through">
                {formatPrice(catalogProduct.price)}
              </span>
            )}
          </div>
        </div>
      </div>

      <VariantMatrix stock={stock} fallbackColors={catalogProduct.colors} />
    </div>
  );
}
