import { notFound } from "next/navigation";
import Link from "next/link";
import { getStorefrontProductByStyle, refreshProductStock } from "@/lib/products";
import { getUnitPrice } from "@/lib/price";
import { CATEGORY_LABELS } from "@/lib/category";
import { ProductColorProvider } from "@/components/ProductColorContext";
import { ProductView } from "@/components/ProductView";
import { StubSection } from "@/components/StubSection";

export default async function ProductPage({
  params,
}: {
  params: Promise<{ style: string }>;
}) {
  const { style: styleParam } = await params;
  const style = decodeURIComponent(styleParam);

  let product = await getStorefrontProductByStyle(style);
  if (!product) {
    notFound();
  }

  // Live stock refresh on open — only fires if a Kelme token is configured;
  // otherwise this is a no-op and we just show the seeded snapshot below.
  product = await refreshProductStock(product);

  const { unitPrice } = getUnitPrice(product);
  const colorNames = [...new Set(product.stock.map((s) => s.color))].filter(Boolean);

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <Link
        href={`/shop?category=${product.category}`}
        className="font-display text-xs uppercase tracking-wide text-neutral-400 hover:text-ink"
      >
        ← {CATEGORY_LABELS[product.category]}
      </Link>

      <ProductColorProvider initialColor={colorNames[0] ?? product.colors[0] ?? ""}>
        <div className="mt-4 mb-10">
          <ProductView product={product} unitPrice={unitPrice} mode="full" />
        </div>
      </ProductColorProvider>

      <StubSection title="Suggested products" />
      <StubSection title="Recently viewed products" />
    </div>
  );
}
