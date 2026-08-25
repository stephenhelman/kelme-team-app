import Link from "next/link";
import type { CatalogProduct } from "@/lib/types";
import { ProductImage } from "./ProductImage";

// A handful of jersey-ish colors for swatches whose color name we can't map
// to a real hex (Kelme gives us a name, not a swatch value).
function swatchColor(colorName: string): string {
  const key = colorName.trim().toLowerCase();
  const known: Record<string, string> = {
    white: "#f4f4f4",
    black: "#1a1a1a",
    red: "#c81e2c",
    blue: "#1e4fc8",
    navy: "#132250",
    green: "#1f7a3d",
    yellow: "#f5c400",
    orange: "#e0641a",
    gray: "#7a7a7a",
    grey: "#7a7a7a",
    purple: "#5b2a86",
    pink: "#e0699f",
    gold: "#c99a2e",
    silver: "#b9bdc4",
  };
  for (const [name, hex] of Object.entries(known)) {
    if (key.includes(name)) return hex;
  }
  // Deterministic fallback so unmapped colors stay visually distinct.
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = key.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 45%, 45%)`;
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export function ProductCard({ product }: { product: CatalogProduct }) {
  const onSale = product.discountPrice > 0 && product.discountPrice < product.price;

  return (
    <Link
      href={`/product/${encodeURIComponent(product.styleCode)}`}
      className="group flex flex-col overflow-hidden rounded-lg border border-white/10 bg-pitch-900/60 transition-colors hover:border-kit-500/50 hover:bg-pitch-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kit-400"
    >
      <ProductImage src={product.image} alt={product.name} className="aspect-square w-full" />

      <div className="flex flex-col gap-2 p-4">
        <span className="font-display text-base uppercase tracking-wide leading-tight text-neutral-50 group-hover:text-kit-400">
          {product.name}
        </span>
        <span className="text-xs text-neutral-500">{product.styleCode}</span>

        <div className="flex items-center gap-1.5" aria-label={`${product.colors.length} colorways`}>
          {product.colors.slice(0, 8).map((color) => (
            <span
              key={color}
              title={color}
              className="h-3.5 w-3.5 rounded-full ring-1 ring-white/20"
              style={{ backgroundColor: swatchColor(color) }}
            />
          ))}
          {product.colors.length > 8 && (
            <span className="text-xs text-neutral-400">+{product.colors.length - 8}</span>
          )}
        </div>

        <div className="mt-1 flex items-baseline gap-2">
          <span className="font-display text-lg text-kit-400">
            {formatPrice(onSale ? product.discountPrice : product.price)}
          </span>
          {onSale && (
            <span className="text-xs text-neutral-500 line-through">{formatPrice(product.price)}</span>
          )}
        </div>
      </div>
    </Link>
  );
}
