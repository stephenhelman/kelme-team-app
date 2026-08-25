"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogProduct } from "@/lib/types";
import { ProductCard } from "./ProductCard";

interface Props {
  initialProducts: CatalogProduct[];
  initialHasMore: boolean;
}

export function Catalog({ initialProducts, initialHasMore }: Props) {
  const [products, setProducts] = useState(initialProducts);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [color, setColor] = useState("");
  const pageRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);

  const fetchPage = useCallback(
    async (page: number, replace: boolean) => {
      const myRequestId = ++requestIdRef.current;
      setLoading(true);
      const params = new URLSearchParams({ page: String(page) });
      if (search) params.set("search", search);
      if (color) params.set("color", color);

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
    [search, color],
  );

  // Filters changed: reset to page 0 (skip on first mount, we already have SSR data).
  const isFirstRun = useRef(true);
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    fetchPage(0, true);
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
    <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-3xl sm:text-4xl uppercase tracking-wide text-neutral-50">
            Catalog
          </h1>
          <p className="mt-1 text-sm text-neutral-400">
            The vendor&apos;s curated Kelme store.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search style or name…"
            className="w-52 rounded-md border border-white/10 bg-pitch-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-kit-500 focus:outline-none focus:ring-1 focus:ring-kit-500"
          />
          <input
            type="text"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            placeholder="Color…"
            className="w-32 rounded-md border border-white/10 bg-pitch-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-kit-500 focus:outline-none focus:ring-1 focus:ring-kit-500"
          />
        </div>
      </div>

      {products.length === 0 && !loading && (
        <p className="py-16 text-center text-sm text-neutral-400">
          No products match those filters yet.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {products.map((product) => (
          <ProductCard key={product.styleCode} product={product} />
        ))}
      </div>

      <div ref={sentinelRef} className="h-4" />

      {loading && (
        <p className="py-8 text-center text-sm text-neutral-400">Loading more products…</p>
      )}
      {!hasMore && !loading && products.length > 0 && (
        <p className="py-8 text-center text-sm text-neutral-500">
          That&apos;s the full catalog.
        </p>
      )}
    </div>
  );
}
