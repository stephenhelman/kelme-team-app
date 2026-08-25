"use client";

import { useState } from "react";
import { resolveImageSrc } from "@/lib/image";

function Placeholder({ label, className = "" }: { label: string; className?: string }) {
  const initials = label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");

  return (
    <div
      className={`flex items-center justify-center bg-pitch-800 ${className}`}
      aria-hidden="true"
    >
      <span className="font-display text-2xl tracking-wide text-white/20">{initials || "K"}</span>
    </div>
  );
}

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

  if (failed) {
    return <Placeholder label={alt} className={className} />;
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- proxied/remote source, dimensions unknown ahead of time
    <img
      src={resolveImageSrc(src)}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`object-cover ${className}`}
    />
  );
}
