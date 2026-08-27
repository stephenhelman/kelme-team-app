"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

// Shared modal chrome: portal, backdrop, escape-to-close, click-outside,
// and the close button. Rendered via portal so the DOM node is detached
// from wherever it's declared (e.g. a catalog card's <Link>) — but a portal
// only moves where the node *lives*, not how React bubbles events: clicks
// still bubble through the component tree the modal was declared in, so the
// backdrop's onClick must preventDefault + stopPropagation itself, not just
// call onClose, or a click-outside can trigger a parent Link's navigation.
// Only ever mounted client-side (after the trigger's onClick), so
// document.body is always available — no SSR guard needed.
export function Modal({
  onClose,
  label,
  children,
  maxWidth = "max-w-sm",
}: {
  onClose: () => void;
  label: string;
  children: React.ReactNode;
  maxWidth?: string;
}) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={`relative flex max-h-[75vh] w-full ${maxWidth} flex-col rounded-xl border border-line bg-white shadow-xl`}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 z-10 text-neutral-400 hover:text-ink"
        >
          ✕
        </button>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
