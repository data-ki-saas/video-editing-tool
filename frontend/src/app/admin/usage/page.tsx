"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useIsAdmin } from "@/lib/useIsAdmin";
import { getAdminUsageSummary, getCapWarnings, type AdminUsageSummary, type CapWarning } from "@/lib/api";

const WINDOW_OPTIONS = [7, 30, 90];
// Fixed, unlike the cost window above -- this is a short recent-activity
// log, not a trend the admin would want to widen/narrow.
const CAP_WARNINGS_WINDOW_DAYS = 7;

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatWarningTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function AdminUsagePage() {
  const router = useRouter();
  const isAdmin = useIsAdmin();

  const [days, setDays] = useState(30);
  const [summary, setSummary] = useState<AdminUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capWarnings, setCapWarnings] = useState<CapWarning[] | null>(null);
  const [capWarningsError, setCapWarningsError] = useState<string | null>(null);

  useEffect(() => {
    if (isAdmin === false) router.replace("/dashboard");
  }, [isAdmin, router]);

  useEffect(() => {
    // Fetched in parallel with the isAdmin check (not gated on it) -- see
    // admin/users/page.tsx's own comment on why.
    getAdminUsageSummary(days)
      .then((result) => {
        setSummary(result);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load usage summary"));
  }, [days]);

  useEffect(() => {
    getCapWarnings(CAP_WARNINGS_WINDOW_DAYS)
      .then((result) => {
        setCapWarnings(result.warnings);
        setCapWarningsError(null);
      })
      .catch((err) => setCapWarningsError(err instanceof Error ? err.message : "Failed to load cap warnings"));
  }, []);

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

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Cap warnings (last {CAP_WARNINGS_WINDOW_DAYS}d)</h2>
        <p className="text-xs text-muted">
          Fires when a non-admin account hits a daily usage cap -- render/voiceover/avatar/background-removal --
          a possible cost-overrun signal. Admin accounts bypass these caps entirely and never appear here.
        </p>
        {capWarningsError && <p className="text-sm text-red-600">{capWarningsError}</p>}
        {!capWarningsError && !capWarnings && <p className="text-sm text-muted">Loading…</p>}
        {capWarnings && capWarnings.length === 0 && (
          <p className="text-sm text-muted">No caps have been hit in this window.</p>
        )}
        {capWarnings && capWarnings.length > 0 && (
          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-border bg-surface p-3 font-mono text-xs">
            {capWarnings.map((warning, index) => (
              <div key={index} className="text-muted">
                <span>{formatWarningTime(warning.createdAt)}</span>{" "}
                <span className="text-foreground">{warning.email ?? warning.userId}</span> hit{" "}
                <span className="text-foreground">{warning.feature}</span> cap ({warning.countAtTrigger}/
                {warning.capValue})
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
