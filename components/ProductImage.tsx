"use client";

import { useState } from "react";
import { resolveImageSrc } from "@/lib/image";

function Placeholder({ label }: { label: string }) {
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

  return (
    <div className="flex h-full w-full items-center justify-center bg-surface" aria-hidden="true">
      <span className="font-display text-2xl tracking-wide text-neutral-300">{initials || "K"}</span>
    </div>
  );
}

// Self-contained sizing: this owns its `relative` wrapper (sized by
// `className`, e.g. "aspect-square w-full" or "h-16 w-16") and the image
// inside is absolutely positioned to fill it exactly. Percentage
// height/width on a normal-flow child of an aspect-ratio box is a known
// source of a sub-pixel gap that reveals the box's own background as a
// stray band — absolute inset-0 against a sized, positioned parent can't
// leave that gap.
export function ProductImage({
  src,
  alt,
  className = "",
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(!src);

  return (
    <div className={`relative overflow-hidden ${className}`}>
      {failed ? (
        <Placeholder label={alt} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- proxied/remote source, dimensions unknown ahead of time
        <img
          src={resolveImageSrc(src)}
          alt={alt}
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </div>
  );
}
