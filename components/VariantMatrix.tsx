import type { Product } from "@/lib/types";
import { getAvailability } from "@/lib/availability";
import { displayWarehouseName } from "@/lib/warehouses";

const CELL_STYLES: Record<string, string> = {
  "in-stock": "bg-kit-500/15 border-kit-500/50 text-kit-400",
  "low-stock": "bg-amber-500/10 border-amber-400/40 text-amber-300",
  "made-to-order": "bg-white/3 border-white/10 text-neutral-500",
};

// Natural sort so sizes read like a kit sheet (S, M, L, XL, 2XL...) rather
// than alphabetically (2XL before L).
function sizeSortKey(size: string): [number, string] {
  const match = size.match(/^(\d+)?\s*(X*S|X*L|M)?$/i);
  if (match) {
    const multiplier = match[1] ? parseInt(match[1], 10) : 1;
    const base = (match[2] ?? "").toUpperCase();
    const order: Record<string, number> = { S: 0, M: 1, L: 2 };
    const xCount = (base.match(/X/g) ?? []).length;
    if (base.endsWith("S")) return [0 - xCount, size];
    if (base.endsWith("L")) return [2 + xCount * multiplier, size];
    if (base === "M") return [1, size];
  }
  const numeric = Number(size);
  if (!Number.isNaN(numeric)) return [10 + numeric, size];
  return [999, size];
}

// Stock overlay is an inventory-cache join by styleCode — it may not exist
// (the favorited catalog includes non-apparel items, or the join just
// hasn't been found yet). Garnish-not-gate: the product still renders with
// whatever color info the catalog itself gave us, just without a size grid.
function ColorChipsFallback({ colors }: { colors: string[] }) {
  if (colors.length === 0) {
    return (
      <p className="rounded-lg border border-white/10 bg-pitch-900/60 p-4 text-sm text-neutral-400">
        No color or size data available for this item yet.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-white/10 bg-pitch-900/60 p-4">
      <p className="mb-3 text-xs uppercase tracking-wide text-neutral-500">
        Colorways · size-level stock not yet linked for this item
      </p>
      <div className="flex flex-wrap gap-2">
        {colors.map((color) => (
          <span
            key={color}
            className="rounded-full border border-white/10 bg-white/3 px-3 py-1 text-sm text-neutral-200"
          >
            {color}
          </span>
        ))}
      </div>
    </div>
  );
}

export function VariantMatrix({
  stock,
  fallbackColors = [],
}: {
  stock: Product | null;
  fallbackColors?: string[];
}) {
  if (!stock) {
    return <ColorChipsFallback colors={fallbackColors} />;
  }

  const sizes = [...new Set(stock.variants.map((v) => v.size))].sort(
    (a, b) => sizeSortKey(a)[0] - sizeSortKey(b)[0] || a.localeCompare(b),
  );
  const colors = [...stock.colors].sort((a, b) => a.color.localeCompare(b.color));

  return (
    <div className="overflow-x-auto rounded-lg border border-white/10 bg-pitch-900/60">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-pitch-900 px-4 py-3 text-left font-display text-xs uppercase tracking-wider text-neutral-400">
              Colorway
            </th>
            {sizes.map((size) => (
              <th
                key={size}
                className="min-w-16 px-2 py-3 text-center font-display text-xs uppercase tracking-wider text-neutral-400"
              >
                {size}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {colors.map((c) => (
            <tr key={c.colorCode} className="border-t border-white/5">
              <th className="sticky left-0 z-10 whitespace-nowrap bg-pitch-900 px-4 py-3 text-left font-medium text-neutral-100">
                {c.color}
                <span className="ml-1.5 text-xs text-neutral-500">#{c.colorCode}</span>
              </th>
              {sizes.map((size) => {
                const variant = stock.variants.find(
                  (v) => v.colorCode === c.colorCode && v.size === size,
                );
                if (!variant) {
                  return <td key={size} className="px-2 py-3 text-center text-neutral-700">—</td>;
                }
                const availability = getAvailability(variant.qty);
                return (
                  <td key={size} className="px-1.5 py-2 text-center align-middle">
                    <div
                      title={variant.warehouses
                        .map((w) => `${displayWarehouseName(w.warehouse)}: ${w.qty}`)
                        .join(" · ")}
                      className={`group mx-auto flex h-14 w-14 flex-col items-center justify-center gap-0.5 rounded-md border transition-transform hover:scale-105 ${CELL_STYLES[availability.level]}`}
                    >
                      <span className="font-display text-base leading-none">{size}</span>
                      <span className="text-[9px] leading-none uppercase tracking-wide">
                        {availability.level === "made-to-order" ? "MTO" : variant.qty}
                      </span>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
