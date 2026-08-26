"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { StoreProduct } from "@/lib/types";
import { CATEGORIES, CATEGORY_LABELS, type ProductCategory } from "@/lib/category";
import { ProductCard } from "./ProductCard";

interface Props {
  initialProducts: StoreProduct[];
  initialHasMore: boolean;
  initialCategory?: ProductCategory;
  initialSearch?: string;
}

export function Catalog({ initialProducts, initialHasMore, initialCategory, initialSearch = "" }: Props) {
  const router = useRouter();
  const [products, setProducts] = useState(initialProducts);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState(initialSearch);
  const [category, setCategory] = useState<ProductCategory | undefined>(initialCategory);
  const pageRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);

  const fetchPage = useCallback(
    async (page: number, replace: boolean) => {
      const myRequestId = ++requestIdRef.current;
      setLoading(true);
      const params = new URLSearchParams({ page: String(page) });
      if (search) params.set("search", search);
      if (category) params.set("category", category);

      try {
        const res = await fetch(`/api/products?${params.toString()}`);
        const data = await res.json();
        if (myRequestId !== requestIdRef.current) return; // stale response, ignore

        setProducts((prev) => (replace ? data.products : [...prev, ...data.products]));
        setHasMore(data.hasMore);
        pageRef.current = page;
      } finally {
        if (myRequestId === requestIdRef.current) setLoading(false);
      }
    },
    [search, category],
  );

  // Filters changed: reset to page 0 (skip on first mount, we already have SSR data).
  const isFirstRun = useRef(true);
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    fetchPage(0, true);

    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (category) params.set("category", category);
    router.replace(`/shop${params.toString() ? `?${params}` : ""}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on filter change, not router identity
  }, [fetchPage]);

  // Infinite scroll.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasMore && !loading) {
          fetchPage(pageRef.current + 1, false);
        }
      },
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loading, fetchPage]);

  return (
    <div className="mx-auto max-w-7xl px-3 py-6 sm:px-6 sm:py-14">
      <div className="mb-6 flex flex-col items-center gap-4 text-center sm:mb-8 sm:gap-6">
        <h1 className="font-display font-bold text-2xl uppercase tracking-wide text-ink sm:text-4xl">
          Shop All Gear
        </h1>

        <div className="flex flex-wrap justify-center gap-2">
          {[{ value: undefined, label: "All" }, ...CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))].map(
            (opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => setCategory(opt.value)}
                className={`font-display rounded-full border px-4 py-1.5 text-xs uppercase tracking-wide transition-colors sm:text-sm ${
                  category === opt.value
                    ? "border-ink bg-ink text-paper"
                    : "border-line text-ink hover:border-ink"
                }`}
              >
                {opt.label}
              </button>
            ),
          )}
        </div>

        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search style or name…"
          className="w-full max-w-64 border-b border-line bg-transparent px-1 py-1.5 text-center text-sm text-ink placeholder:text-neutral-400 focus:border-ink focus:outline-none"
        />
      </div>

      {products.length === 0 && !loading && (
        <p className="py-16 text-center text-sm text-neutral-500">
          No products match those filters yet.
        </p>
      )}

      <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:gap-x-6 sm:gap-y-10 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {products.map((product) => (
          <ProductCard key={product.styleCode} product={product} />
        ))}
      </div>

      <div ref={sentinelRef} className="h-4" />

      {loading && (
        <p className="py-8 text-center text-sm text-neutral-500">Loading more products…</p>
      )}
      {!hasMore && !loading && products.length > 0 && (
        <p className="py-8 text-center text-sm text-neutral-400">
          That&apos;s the full catalog.
        </p>
      )}
    </div>
  );
}
