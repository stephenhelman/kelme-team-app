"use client";

import { createContext, useContext, useState } from "react";

interface ProductColorContextValue {
  selectedColor: string;
  setSelectedColor: (color: string) => void;
}

const ProductColorContext = createContext<ProductColorContextValue | null>(null);

// Color is a single piece of selected state, shared by the image, the color
// swatches, and the size/stock grid below — they all derive from this.
export function ProductColorProvider({
  initialColor,
  children,
}: {
  initialColor: string;
  children: React.ReactNode;
}) {
  const [selectedColor, setSelectedColor] = useState(initialColor);
  return (
    <ProductColorContext.Provider value={{ selectedColor, setSelectedColor }}>
      {children}
    </ProductColorContext.Provider>
  );
}

export function useProductColor(): ProductColorContextValue {
  const ctx = useContext(ProductColorContext);
  if (!ctx) throw new Error("useProductColor must be used within ProductColorProvider");
  return ctx;
}
