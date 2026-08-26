import { notFound } from "next/navigation";
import Link from "next/link";
import { getStorefrontProductByStyle, refreshProductStock } from "@/lib/products";
import { getProductColorNames } from "@/lib/colors";
import { getStockPill } from "@/lib/availability";
import { CATEGORY_LABELS } from "@/lib/category";
import { KitSelector } from "@/components/KitSelector";
import { ProductColorProvider } from "@/components/ProductColorContext";
import { ProductColorImage } from "@/components/ProductColorImage";
import { ColorSwatches } from "@/components/ColorSwatches";

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function formatSyncedAt(iso: string | null): string {
  if (!iso) return "not yet synced";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

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

  const hasDiscount = product.discount != null && product.discount > 0 && product.sellPrice != null;
  const unitPrice =
    hasDiscount && product.sellPrice != null && product.discount != null
      ? product.sellPrice * (1 - product.discount / 100)
      : product.sellPrice;

  const colorNames = getProductColorNames(product);
  const pill = getStockPill(product.stock.map((s) => s.qty));

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <Link
        href={`/shop?category=${product.category}`}
        className="font-display text-xs uppercase tracking-wide text-neutral-400 hover:text-ink"
      >
        ← {CATEGORY_LABELS[product.category]}
      </Link>

      <ProductColorProvider initialColor={colorNames[0] ?? ""}>
        <div className="mt-4 mb-10 grid grid-cols-1 gap-8 sm:grid-cols-[400px_1fr]">
          <div className="relative overflow-hidden rounded-xl bg-surface">
            <ProductColorImage product={product} className="aspect-square w-full" />
            <span
              className={`font-display absolute left-3 top-3 rounded-full px-2.5 py-1 text-[10px] uppercase tracking-wide ${
                pill.level === "in-stock" ? "bg-white text-ink" : "bg-white/90 text-neutral-500"
              }`}
            >
              {pill.label}
            </span>
          </div>

          <div className="flex flex-col justify-center gap-4">
            <div>
              <h1 className="font-display font-bold text-3xl uppercase tracking-wide text-ink sm:text-4xl">
                {product.name}
              </h1>
              <p className="text-sm text-neutral-400">{product.styleCode}</p>
            </div>

            <div className="flex items-baseline gap-2">
              {unitPrice != null ? (
                <>
                  <span className="font-display text-2xl text-ink">{formatPrice(unitPrice)}</span>
                  {hasDiscount && product.sellPrice != null && (
                    <span className="text-sm text-neutral-400 line-through">
                      {formatPrice(product.sellPrice)}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-base text-neutral-400">Price not set</span>
              )}
            </div>

            {colorNames.length > 0 && <ColorSwatches colors={colorNames} />}

            <p className="text-xs text-neutral-400">
              Inventory last synced {formatSyncedAt(product.stockSyncedAt)}
            </p>
          </div>
        </div>

        {colorNames.length > 0 ? (
          <KitSelector product={product} unitPrice={unitPrice} />
        ) : (
          <p className="rounded-xl border border-line bg-white p-5 text-sm text-neutral-500">
            No color or size data available for this item yet.
          </p>
        )}
      </ProductColorProvider>
    </div>
  );
}
