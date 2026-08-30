"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useIsAdmin } from "@/lib/useIsAdmin";
import { getAdminUsageSummary, type AdminUsageSummary } from "@/lib/api";

const WINDOW_OPTIONS = [7, 30, 90];

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function AdminUsagePage() {
  const router = useRouter();
  const isAdmin = useIsAdmin();

  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<AdminUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isAdmin === false) router.replace("/dashboard");
  }, [isAdmin, router]);

  useEffect(() => {
    if (isAdmin !== true) return;
    getAdminUsageSummary(days)
      .then((result) => {
        setSummary(result);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load usage summary"));
  }, [isAdmin, days]);

  if (isAdmin !== true) return null;

  const maxDailyCost = summary ? Math.max(...summary.daily.map((d) => d.costEstimateCents), 1) : 1;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-12">
      <div>
        <Link href="/admin" className="text-sm text-muted hover:underline">
          ← Admin
        </Link>
        <h1 className="text-2xl font-semibold">Usage & cost dashboard</h1>
        <p className="text-sm text-muted">
          Estimated cost across all users, from usage_ledger -- see backend/src/metering/pricing.py for the
          per-provider rates these estimates are computed from.
        </p>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted">Window:</span>
        {WINDOW_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setDays(option)}
            className={`rounded-md border border-border px-3 py-1 ${
              days === option ? "bg-accent text-accent-foreground" : "hover:bg-surface"
            }`}
          >
            {option}d
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && !summary && <p className="text-sm text-muted">Loading…</p>}

      {summary && (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Totals by feature</h2>
            {summary.totals.length === 0 ? (
              <p className="text-sm text-muted">No usage recorded in this window.</p>
            ) : (
              <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                {summary.totals.map((total) => (
                  <div key={total.eventType} className="flex items-center justify-between gap-3 p-3 text-sm">
                    <span>{total.eventType}</span>
                    <span className="text-muted">
                      {total.count} events · {total.quantitySum.toFixed(1)} units · {formatCents(total.costEstimateCentsSum)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Daily cost</h2>
            {summary.daily.length === 0 ? (
              <p className="text-sm text-muted">No usage recorded in this window.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {summary.daily.map((day) => (
                  <div key={day.date} className="flex items-center gap-3">
                    <span className="w-24 shrink-0 text-xs text-muted">{day.date}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${(day.costEstimateCents / maxDailyCost) * 100}%` }}
                      />
                    </div>
                    <span className="w-16 shrink-0 text-right text-xs text-muted">{formatCents(day.costEstimateCents)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium">Top users by cost</h2>
            {summary.topUsers.length === 0 ? (
              <p className="text-sm text-muted">No usage recorded in this window.</p>
            ) : (
              <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                {summary.topUsers.map((user) => (
                  <div key={user.userId} className="flex items-center justify-between gap-3 p-3 text-sm">
                    <span className="font-mono text-xs">{user.email ?? user.userId}</span>
                    <span className="text-muted">{formatCents(user.costEstimateCentsSum)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
