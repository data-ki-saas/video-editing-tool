"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getBillingStatement, getUsageSummary, type UsageSummaryItem } from "@/lib/api";

export default function UsagePage() {
  const [items, setItems] = useState<UsageSummaryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [monthTotalCents, setMonthTotalCents] = useState<number | null>(null);

  useEffect(() => {
    getUsageSummary()
      .then((body) => setItems(body.items))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    getBillingStatement()
      .then((statement) => setMonthTotalCents(statement.totalCents))
      .catch(() => undefined);
  }, []);

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-12">
      <div>
        <Link href="/dashboard" className="text-sm text-muted hover:underline">
          ← Reels
        </Link>
        <h1 className="text-2xl font-semibold">Usage</h1>
      </div>

      {monthTotalCents !== null && (
        <Link
          href="/account/billing"
          className="flex items-baseline justify-between rounded-lg border border-border p-4 hover:bg-surface"
        >
          <span className="text-sm">Charges so far this month</span>
          <span className="font-semibold">${(monthTotalCents / 100).toFixed(2)} · Monthly billing →</span>
        </Link>
      )}

      <section className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          Each of these resets 24 hours after your first use of the day -- a guardrail against
          runaway usage, not a billing plan.
        </p>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {!error && !items && <p className="text-sm text-muted">Loading…</p>}

        {items?.map((item) => {
          const fraction = item.limit > 0 ? Math.min(item.count / item.limit, 1) : 0;
          return (
            <div key={item.eventType} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between text-sm">
                <span>{item.label}</span>
                <span className="text-muted">
                  {item.count} / {item.limit} today
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: `${fraction * 100}%` }}
                />
              </div>
            </div>
          );
        })}
      </section>
    </main>
  );
}
