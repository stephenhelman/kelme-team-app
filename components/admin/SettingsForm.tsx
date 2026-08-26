"use client";

import { useState } from "react";
import type { StoreSettings } from "@/lib/settings";

export function SettingsForm({ settings }: { settings: StoreSettings }) {
  const [shippingPerUnit, setShippingPerUnit] = useState(settings.shippingPerUnit.toString());
  const [minOrderUnits, setMinOrderUnits] = useState(settings.minOrderUnits.toString());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    await fetch("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shippingPerUnit: Number(shippingPerUnit),
        minOrderUnits: Number(minOrderUnits),
      }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-sm flex-col gap-4 rounded-xl border border-line bg-white p-5">
      <label className="flex flex-col gap-1 text-sm text-neutral-600">
        Shipping per unit ($)
        <input
          type="number"
          min={0}
          step="0.01"
          value={shippingPerUnit}
          onChange={(e) => setShippingPerUnit(e.target.value)}
          className="rounded-md border border-line bg-white px-3 py-2 text-ink focus:border-ink focus:outline-none"
        />
        <span className="text-xs text-neutral-400">Vendor&apos;s real average is $2.50–$3.50.</span>
      </label>

      <label className="flex flex-col gap-1 text-sm text-neutral-600">
        Minimum order (units)
        <input
          type="number"
          min={1}
          value={minOrderUnits}
          onChange={(e) => setMinOrderUnits(e.target.value)}
          className="rounded-md border border-line bg-white px-3 py-2 text-ink focus:border-ink focus:outline-none"
        />
      </label>

      <button
        type="submit"
        disabled={saving}
        className="font-display rounded-full bg-ink px-4 py-2 uppercase tracking-wide text-paper transition-colors hover:bg-neutral-800 disabled:opacity-50"
      >
        {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
      </button>
    </form>
  );
}
