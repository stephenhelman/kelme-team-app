"use client";

import { swatchColor } from "@/lib/swatch";
import { useProductColor } from "./ProductColorContext";

export function ColorSwatches({ colors }: { colors: string[] }) {
  const { selectedColor, setSelectedColor } = useProductColor();

  return (
    <div className="flex flex-wrap gap-3" role="radiogroup" aria-label="Colorway">
      {colors.map((color) => {
        const selected = color === selectedColor;
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => setSelectedColor(color)}
            className="group flex flex-col items-center gap-1.5 focus-visible:outline-none"
          >
            <span
              className={`flex h-10 w-10 items-center justify-center rounded-full ring-2 ring-offset-2 ring-offset-white transition-colors ${
                selected
                  ? "ring-ink"
                  : "ring-transparent group-hover:ring-line group-focus-visible:ring-neutral-400"
              }`}
            >
              <span
                className="h-8 w-8 rounded-full ring-1 ring-black/10"
                style={{ backgroundColor: swatchColor(color) }}
              />
            </span>
            <span className={`max-w-20 truncate text-xs ${selected ? "text-ink" : "text-neutral-400"}`}>
              {color}
            </span>
          </button>
        );
      })}
    </div>
  );
}
