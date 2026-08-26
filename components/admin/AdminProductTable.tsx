"use client";

import { useState } from "react";
import type { StoreProduct } from "@/lib/types";
import { CATEGORIES, CATEGORY_LABELS, type ProductCategory } from "@/lib/category";

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function ProductRow({ product }: { product: StoreProduct }) {
  const [sellPrice, setSellPrice] = useState(product.sellPrice?.toString() ?? "");
  const [discount, setDiscount] = useState(product.discount?.toString() ?? "");
  const [isPublished, setIsPublished] = useState(product.isPublished);
  const [categoryOverride, setCategoryOverride] = useState<ProductCategory | "">(product.categoryOverride ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save(patch: Record<string, unknown>) {
    setSaving(true);
    setSaved(false);
    await fetch(`/api/admin/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function commitPrice() {
    const value = sellPrice.trim() === "" ? null : Number(sellPrice);
    save({ sellPrice: value });
  }

  function commitDiscount() {
    const value = discount.trim() === "" ? null : Number(discount);
    save({ discount: value });
  }

  function togglePublished() {
    const next = !isPublished;
    setIsPublished(next);
    save({ isPublished: next });
  }

  function handleCategoryChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value as ProductCategory | "";
    setCategoryOverride(value);
    save({ categoryOverride: value === "" ? null : value });
  }

  return (
    <tr className={`border-t border-line ${!product.active ? "opacity-50" : ""}`}>
      <td className="px-3 py-3">
        <p className="font-display text-sm uppercase tracking-wide text-ink">{product.name}</p>
        <p className="text-xs text-neutral-400">
          {product.styleCode}
          {!product.active && " · inactive"}
        </p>
      </td>
      <td className="px-3 py-3">
        <select
          value={categoryOverride}
          onChange={handleCategoryChange}
          className={`rounded border border-line bg-white px-2 py-1 text-xs focus:border-ink focus:outline-none ${
            categoryOverride === "" ? "text-neutral-400" : "text-ink"
          }`}
        >
          <option value="">Auto: {CATEGORY_LABELS[product.category]}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-3 text-right text-sm text-neutral-400">
        {formatPrice(product.kelmeCatalogPrice)}
      </td>
      <td className="px-3 py-3 text-right text-sm text-neutral-400">{formatPrice(product.kelmeFobCost)}</td>
      <td className="px-3 py-3">
        <input
          type="number"
          min={0}
          step="0.01"
          value={sellPrice}
          onChange={(e) => setSellPrice(e.target.value)}
          onBlur={commitPrice}
          placeholder="Not set"
          className="w-24 rounded border border-line bg-white px-2 py-1 text-right text-sm text-ink focus:border-ink focus:outline-none"
        />
      </td>
      <td className="px-3 py-3">
        <input
          type="number"
          min={0}
          max={100}
          value={discount}
          onChange={(e) => setDiscount(e.target.value)}
          onBlur={commitDiscount}
          placeholder="0"
          className="w-16 rounded border border-line bg-white px-2 py-1 text-right text-sm text-ink focus:border-ink focus:outline-none"
        />
        <span className="ml-1 text-xs text-neutral-400">%</span>
      </td>
      <td className="px-3 py-3 text-center">
        <input
          type="checkbox"
          checked={isPublished}
          onChange={togglePublished}
          className="h-4 w-4 accent-ink"
        />
      </td>
      <td className="w-16 px-3 py-3 text-right text-xs text-neutral-400">
        {saving ? "Saving…" : saved ? "Saved ✓" : ""}
      </td>
    </tr>
  );
}

export function AdminProductTable({ products }: { products: StoreProduct[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-white">
      <table className="w-full min-w-205 border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wider text-neutral-400">
            <th className="px-3 py-3">Product</th>
            <th className="px-3 py-3">Category</th>
            <th className="px-3 py-3 text-right">Kelme catalog</th>
            <th className="px-3 py-3 text-right">Kelme FOB</th>
            <th className="px-3 py-3 text-left">Sell price</th>
            <th className="px-3 py-3 text-left">Discount</th>
            <th className="px-3 py-3 text-center">Published</th>
            <th className="px-3 py-3" />
          </tr>
        </thead>
        <tbody>
          {products.map((product) => (
            <ProductRow key={product.id} product={product} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
