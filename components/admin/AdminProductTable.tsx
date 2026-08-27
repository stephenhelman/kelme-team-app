"use client";

import { useEffect, useMemo, useState } from "react";
import type { StoreProduct } from "@/lib/types";
import { CATEGORIES, CATEGORY_LABELS, type ProductCategory } from "@/lib/category";

const DRAFTS_KEY = "admin-product-drafts";

interface Draft {
  sellPrice?: number | null;
  discount?: number | null;
  isPublished?: boolean;
  categoryOverride?: ProductCategory | null;
}

type Drafts = Record<number, Draft>;

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function loadDrafts(): Drafts {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY);
    return raw ? (JSON.parse(raw) as Drafts) : {};
  } catch {
    return {};
  }
}

function ProductRow({
  product,
  draft,
  onChange,
}: {
  product: StoreProduct;
  draft: Draft | undefined;
  onChange: (patch: Draft) => void;
}) {
  const sellPrice = draft?.sellPrice !== undefined ? draft.sellPrice : product.sellPrice;
  const discount = draft?.discount !== undefined ? draft.discount : product.discount;
  const isPublished = draft?.isPublished !== undefined ? draft.isPublished : product.isPublished;
  const categoryOverride =
    draft?.categoryOverride !== undefined ? draft.categoryOverride : product.categoryOverride;

  const dirty = draft !== undefined && Object.keys(draft).length > 0;

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
          value={categoryOverride ?? ""}
          onChange={(e) => {
            const value = e.target.value as ProductCategory | "";
            onChange({ categoryOverride: value === "" ? null : value });
          }}
          className={`rounded border border-line bg-white px-2 py-1 text-xs focus:border-ink focus:outline-none ${
            categoryOverride === null ? "text-neutral-400" : "text-ink"
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
          value={sellPrice ?? ""}
          onChange={(e) => {
            const value = e.target.value.trim();
            onChange({ sellPrice: value === "" ? null : Number(value) });
          }}
          placeholder="Not set"
          className="w-24 rounded border border-line bg-white px-2 py-1 text-right text-sm text-ink focus:border-ink focus:outline-none"
        />
      </td>
      <td className="px-3 py-3">
        <input
          type="number"
          min={0}
          max={100}
          value={discount ?? ""}
          onChange={(e) => {
            const value = e.target.value.trim();
            onChange({ discount: value === "" ? null : Number(value) });
          }}
          placeholder="0"
          className="w-16 rounded border border-line bg-white px-2 py-1 text-right text-sm text-ink focus:border-ink focus:outline-none"
        />
        <span className="ml-1 text-xs text-neutral-400">%</span>
      </td>
      <td className="px-3 py-3 text-center">
        <input
          type="checkbox"
          checked={isPublished}
          onChange={(e) => onChange({ isPublished: e.target.checked })}
          className="h-4 w-4 accent-ink"
        />
      </td>
      <td className="w-16 px-3 py-3 text-right text-xs text-neutral-400">{dirty ? "Unsaved" : ""}</td>
    </tr>
  );
}

export function AdminProductTable({ products }: { products: StoreProduct[] }) {
  const [productMap, setProductMap] = useState(() => new Map(products.map((p) => [p.id, p])));
  const [drafts, setDrafts] = useState<Drafts>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failedIds, setFailedIds] = useState<number[]>([]);

  // Restore any unsaved edits left over from a previous visit.
  useEffect(() => {
    setDrafts(loadDrafts());
    setLoaded(true);
  }, []);

  // Persist drafts as they change so a reload/navigation doesn't lose them.
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      // localStorage unavailable (private mode, quota) — edits still work in-memory.
    }
  }, [drafts, loaded]);

  const dirtyIds = useMemo(
    () => Object.keys(drafts).filter((id) => Object.keys(drafts[Number(id)]).length > 0),
    [drafts],
  );

  function handleChange(id: number, patch: Draft) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    setFailedIds((prev) => prev.filter((failedId) => failedId !== id));
  }

  async function handleSaveAll() {
    const items = dirtyIds.map((idStr) => {
      const id = Number(idStr);
      return { id, ...drafts[id] };
    });
    if (items.length === 0) return;

    setSaving(true);
    try {
      const res = await fetch("/api/admin/products/batch", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const data = (await res.json()) as { results: { id: number; ok: boolean }[] };

      setProductMap((prev) => {
        const next = new Map(prev);
        for (const result of data.results) {
          if (result.ok) {
            const existing = next.get(result.id);
            const patch = drafts[result.id];
            if (existing && patch) next.set(result.id, { ...existing, ...patch });
          }
        }
        return next;
      });

      setDrafts((prev) => {
        const next = { ...prev };
        for (const result of data.results) {
          if (result.ok) delete next[result.id];
        }
        return next;
      });

      setFailedIds(data.results.filter((r) => !r.ok).map((r) => r.id));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
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
            {[...productMap.values()].map((product) => (
              <ProductRow
                key={product.id}
                product={product}
                draft={drafts[product.id]}
                onChange={(patch) => handleChange(product.id, patch)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {dirtyIds.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 flex justify-center px-4 pb-4 sm:pb-6">
          <div className="flex items-center gap-4 rounded-full border border-line bg-ink px-5 py-3 text-paper shadow-xl">
            <span className="text-sm">
              {dirtyIds.length} unsaved change{dirtyIds.length === 1 ? "" : "s"}
              {failedIds.length > 0 && (
                <span className="ml-2 text-red-300">
                  · {failedIds.length} failed to save
                </span>
              )}
            </span>
            <button
              type="button"
              onClick={handleSaveAll}
              disabled={saving}
              className="font-display rounded-full bg-paper px-4 py-1.5 text-xs uppercase tracking-wide text-ink transition-opacity hover:opacity-80 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save all"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
