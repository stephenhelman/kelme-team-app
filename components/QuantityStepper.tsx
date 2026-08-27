"use client";

export function QuantityStepper({
  qty,
  onChange,
  size = "md",
}: {
  qty: number;
  onChange: (qty: number) => void;
  size?: "md" | "sm";
}) {
  const dims = size === "sm" ? "h-8 w-8 text-sm" : "h-10 w-10 text-base";
  return (
    <div className="flex items-center rounded-full border border-line">
      <button
        type="button"
        aria-label="Decrease quantity"
        onClick={() => onChange(Math.max(1, qty - 1))}
        className={`flex items-center justify-center rounded-l-full text-neutral-500 hover:bg-surface hover:text-ink ${dims}`}
      >
        −
      </button>
      <input
        type="number"
        min={1}
        value={qty}
        onChange={(e) => onChange(Math.max(1, Number(e.target.value) || 1))}
        aria-label="Quantity"
        className="w-10 border-x border-line bg-white py-1 text-center text-sm text-ink focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        aria-label="Increase quantity"
        onClick={() => onChange(qty + 1)}
        className={`flex items-center justify-center rounded-r-full text-neutral-500 hover:bg-surface hover:text-ink ${dims}`}
      >
        +
      </button>
    </div>
  );
}
