"use client";

import Link from "next/link";
import { useCart } from "./CartProvider";

export function CartBadge() {
  const { totalUnits } = useCart();

  return (
    <Link
      href="/cart"
      className="font-display flex items-center gap-2 text-sm uppercase tracking-wide text-ink transition-colors hover:text-kit-600"
    >
      Cart
      {totalUnits > 0 && (
        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-ink px-1 text-xs text-paper">
          {totalUnits}
        </span>
      )}
    </Link>
  );
}
