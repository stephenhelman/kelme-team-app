"use client";

import { useEffect, useState } from "react";

interface Captcha {
  imageUrl: string;
  sign: string;
  pem: string;
}

export default function ReauthPage() {
  const [captcha, setCaptcha] = useState<Captcha | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  async function loadCaptcha() {
    setLoadError(null);
    setError(null);
    setCode("");
    try {
      const res = await fetch("/api/kelme/reauth", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) {
        setLoadError(data.error ?? "Failed to load captcha");
        return;
      }
      setCaptcha(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount, not a render-driven update
    void loadCaptcha();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetch-on-mount only
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!captcha || code.length === 0) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/kelme/reauth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pem: captcha.pem, sign: captcha.sign, code }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Login failed — try again");
        setCode("");
        if (data.captcha) {
          setCaptcha(data.captcha);
        } else {
          await loadCaptcha();
        }
        return;
      }

      setSuccess(true);
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="mx-auto flex max-w-sm flex-col gap-4 px-4 py-24">
        <h1 className="font-display font-bold text-3xl uppercase tracking-wide text-ink">
          Kelme re-auth
        </h1>
        <p className="text-sm text-neutral-600">
          Token stored — status alive. The app and worker will pick it up on their next call.
        </p>
        <button
          onClick={() => {
            setSuccess(false);
            loadCaptcha();
          }}
          className="font-display self-start rounded-full border border-line px-4 py-2 text-sm uppercase tracking-wide text-ink transition-colors hover:bg-neutral-100"
        >
          Re-auth again
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-6 px-4 py-24">
      <div>
        <h1 className="font-display font-bold text-3xl uppercase tracking-wide text-ink">
          Kelme re-auth
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Solve the captcha to (re)establish the Kelme session token. Credentials stay server-side.
        </p>
      </div>

      {loadError && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-red-600">{loadError}</p>
          <button
            onClick={loadCaptcha}
            className="font-display self-start rounded-full border border-line px-4 py-2 text-sm uppercase tracking-wide text-ink transition-colors hover:bg-neutral-100"
          >
            Retry
          </button>
        </div>
      )}

      {captcha && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- data: URL captcha image, not an optimizable asset */}
          <img
            src={captcha.imageUrl}
            alt="Kelme login captcha"
            className="h-auto w-full rounded-md border border-line"
          />
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={4}
            autoFocus
            autoComplete="off"
            placeholder="4-character code"
            className="rounded-md border border-line bg-white px-3 py-2 text-center text-lg tracking-[0.4em] text-ink focus:border-ink focus:outline-none"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={loading || code.length === 0}
              className="font-display flex-1 rounded-full bg-ink px-4 py-2 uppercase tracking-wide text-paper transition-colors hover:bg-neutral-800 disabled:opacity-50"
            >
              {loading ? "Verifying…" : "Submit"}
            </button>
            <button
              type="button"
              onClick={loadCaptcha}
              disabled={loading}
              className="font-display rounded-full border border-line px-4 py-2 text-sm uppercase tracking-wide text-ink transition-colors hover:bg-neutral-100 disabled:opacity-50"
            >
              New captcha
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
