"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useIsAdmin } from "@/lib/useIsAdmin";
import { getAdminPricing, setResourcePrice, type PricedResource } from "@/lib/api";

function formatUnitPrice(cents: number | null): string {
  if (cents === null) return "Not set (free)";
  return `${cents}¢ ($${(cents / 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")})`;
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

function PriceRow({ item, onSaved }: { item: PricedResource; onSaved: (items: PricedResource[]) => void }) {
  const [draft, setDraft] = useState(item.unitPriceCents === null ? "" : String(item.unitPriceCents));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const parsed = draft.trim() === "" ? NaN : Number(draft);
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000_000;
  const unchanged = valid && parsed === item.unitPriceCents;

  async function save() {
    if (!valid || unchanged) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await setResourcePrice(item.key, parsed));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save price");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-medium">{item.label}</p>
          <p className="text-xs text-muted">Priced per {item.unitLabel}</p>
        </div>
        <div className="text-right text-xs text-muted">
          <p>Current: {formatUnitPrice(item.unitPriceCents)}</p>
          {item.effectiveFrom && <p>since {formatWhen(item.effectiveFrom)}</p>}
          {item.providerCostCents !== null && <p>Our estimated cost: {item.providerCostCents}¢</p>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="text-muted" htmlFor={`price-${item.key}`}>
          New price (¢ per {item.unitLabel})
        </label>
        <input
          id={`price-${item.key}`}
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="w-32 rounded-md border border-border bg-background px-2 py-1"
        />
        <button
          type="button"
          onClick={save}
          disabled={!valid || unchanged || saving}
          className="rounded-md bg-accent px-3 py-1 text-accent-foreground disabled:opacity-50"
        >
          {saving ? "Saving…" : "Apply now"}
        </button>
        {item.history.length > 1 && (
          <button type="button" onClick={() => setShowHistory((v) => !v)} className="text-xs text-muted hover:underline">
            {showHistory ? "Hide history" : "Price history"}
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {draft.trim() !== "" && !valid && <p className="text-sm text-red-600">Enter a number from 0 to 1,000,000.</p>}

      {showHistory && (
        <ul className="flex flex-col gap-1 text-xs text-muted">
          {item.history.map((h) => (
            <li key={h.effectiveFrom}>
              {formatUnitPrice(h.unitPriceCents)} — from {formatWhen(h.effectiveFrom)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function AdminPricingPage() {
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const [items, setItems] = useState<PricedResource[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isAdmin === false) router.replace("/dashboard");
  }, [isAdmin, router]);

  useEffect(() => {
    getAdminPricing()
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load pricing"));
  }, []);

  if (isAdmin !== true) return null;

  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Pricing</h1>
        <p className="text-sm text-muted">
          What users are charged for each consumption item. These prices feed the usage shown to users and their
          monthly billing statement. A change applies immediately, to usage from that moment onwards — usage that
          already happened keeps the price it was charged at.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && !items && <p className="text-sm text-muted">Loading…</p>}

      {items?.map((item) => (
        // Keyed on the current price too, so a saved change re-seeds the input.
        <PriceRow key={`${item.key}:${item.unitPriceCents}`} item={item} onSaved={setItems} />
      ))}
    </div>
  );
}
