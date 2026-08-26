"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export interface CartItem {
  key: string; // productId-color-size
  productId: number;
  styleCode: string;
  name: string;
  imageUrl: string;
  color: string;
  colorCode: string;
  size: string;
  qty: number;
  unitPrice: number;
}

interface CartContextValue {
  items: CartItem[];
  addItems: (items: Omit<CartItem, "key">[]) => void;
  removeItem: (key: string) => void;
  setItemQty: (key: string, qty: number) => void;
  clear: () => void;
  totalUnits: number;
  itemsTotal: number;
}

const CartContext = createContext<CartContextValue | null>(null);
const STORAGE_KEY = "kelme-cart";

function keyOf(item: { productId: number; color: string; size: string }): string {
  return `${item.productId}::${item.color}::${item.size}`;
}

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // One-time hydration from localStorage on mount — an effect is the
      // right place for this (reading an external system), not a lazy
      // useState initializer, which would run during SSR and mismatch.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setItems(JSON.parse(raw));
    } catch {
      // Ignore malformed/blocked storage — cart just starts empty.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      // Storage may be unavailable (private mode, quota) — cart still works in-memory.
    }
  }, [items, hydrated]);

  const addItems = useCallback((newItems: Omit<CartItem, "key">[]) => {
    setItems((prev) => {
      const next = [...prev];
      for (const newItem of newItems) {
        const key = keyOf(newItem);
        const existingIndex = next.findIndex((i) => i.key === key);
        if (existingIndex >= 0) {
          next[existingIndex] = { ...next[existingIndex], qty: next[existingIndex].qty + newItem.qty };
        } else {
          next.push({ ...newItem, key });
        }
      }
      return next;
    });
  }, []);

  const removeItem = useCallback((key: string) => {
    setItems((prev) => prev.filter((i) => i.key !== key));
  }, []);

  const setItemQty = useCallback((key: string, qty: number) => {
    setItems((prev) =>
      qty <= 0 ? prev.filter((i) => i.key !== key) : prev.map((i) => (i.key === key ? { ...i, qty } : i)),
    );
  }, []);

  const clear = useCallback(() => setItems([]), []);

  const totalUnits = useMemo(() => items.reduce((sum, i) => sum + i.qty, 0), [items]);
  const itemsTotal = useMemo(() => items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0), [items]);

  const value = useMemo(
    () => ({ items, addItems, removeItem, setItemQty, clear, totalUnits, itemsTotal }),
    [items, addItems, removeItem, setItemQty, clear, totalUnits, itemsTotal],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within CartProvider");
  return ctx;
}
