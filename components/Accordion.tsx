"use client";

import { useState } from "react";

export function AccordionItem({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-line">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full items-center justify-between py-3.5 text-left"
      >
        <span className="font-display text-sm uppercase tracking-wide text-ink">{title}</span>
        <span
          aria-hidden="true"
          className={`font-display text-lg leading-none text-neutral-400 transition-transform ${open ? "rotate-45" : ""}`}
        >
          +
        </span>
      </button>
      {open && <div className="pb-4 text-sm text-neutral-600">{children}</div>}
    </div>
  );
}

export function Accordion({ children }: { children: React.ReactNode }) {
  return <div className="border-t border-line">{children}</div>;
}
