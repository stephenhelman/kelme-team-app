"use client";

import Link from "next/link";
import { useCart } from "./CartProvider";

export function CartBadge() {
  const { totalUnits } = useCart();

  return (
    <Link
      href="/cart"
      aria-label="Cart"
      className="font-display relative flex items-center gap-2 text-ink transition-colors hover:text-kit-600"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M6 8h12l-1 12H7L6 8Z" strokeLinejoin="round" />
        <path d="M9 8V6a3 3 0 0 1 6 0v2" strokeLinecap="round" />
      </svg>
      <span className="hidden text-sm uppercase tracking-wide sm:inline">Cart</span>
      {totalUnits > 0 && (
        <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-ink px-1 text-[10px] text-paper sm:static sm:h-5 sm:min-w-5 sm:text-xs">
          {totalUnits}
        </span>
      )}
    </Link>
  );
}
