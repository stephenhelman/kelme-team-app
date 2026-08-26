"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function RefreshFromKelmeButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setLoading(true);
    setMessage(null);

    const res = await fetch("/api/admin/refresh", { method: "POST" });
    const data = await res.json();
    setLoading(false);

    if (!res.ok) {
      setMessage(data.error ?? "Refresh failed");
      return;
    }

    setMessage(
      `Synced ${data.fetched} products, ${data.stockUpdated} stock updates, ${data.markedInactive} marked inactive.`,
    );
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="rounded-full border border-line px-3 py-1.5 text-sm text-neutral-600 transition-colors hover:border-ink hover:text-ink disabled:opacity-50"
      >
        {loading ? "Refreshing…" : "Refresh from Kelme"}
      </button>
      {message && <p className="max-w-xs text-right text-xs text-neutral-400">{message}</p>}
    </div>
  );
}
