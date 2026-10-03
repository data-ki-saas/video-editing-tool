"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getBillingStatement, type BillingStatement } from "@/lib/api";

function formatMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatUnitPrice(cents: number | null): string {
  if (cents === null) return "—";
  if (cents === 0) return "Free";
  return `${cents}¢`;
}

function formatUnits(units: number): string {
  return units.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function shiftMonth(month: string, delta: number): string {
  const [year, mon] = month.split("-").map(Number);
  return monthKey(new Date(Date.UTC(year, mon - 1 + delta, 1)));
}

function monthTitle(month: string): string {
  const [year, mon] = month.split("-").map(Number);
  return new Date(Date.UTC(year, mon - 1, 1)).toLocaleString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

export default function BillingPage() {
  const currentMonth = monthKey(new Date());
  const [month, setMonth] = useState(currentMonth);
  // Result is tagged with the month it was fetched for, so switching months
  // shows "Loading" (result.month !== month) without resetting state in the effect.
  const [result, setResult] = useState<{ month: string; statement?: BillingStatement; error?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBillingStatement(month)
      .then((statement) => {
        if (!cancelled) setResult({ month, statement });
      })
      .catch((err) => {
        if (!cancelled) setResult({ month, error: err instanceof Error ? err.message : "Failed to load billing" });
      });
    return () => {
      cancelled = true;
    };
  }, [month]);

  const current = result?.month === month ? result : null;
  const statement = current?.statement ?? null;
  const error = current?.error ?? null;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-12">
      <div>
        <Link href="/account/usage" className="text-sm text-muted hover:underline">
          ← Usage
        </Link>
        <h1 className="text-2xl font-semibold">Monthly billing</h1>
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setMonth(shiftMonth(month, -1))}
          className="rounded-md border border-border px-3 py-1 text-sm hover:bg-surface"
        >
          ← Previous
        </button>
        <span className="font-medium">{monthTitle(month)}</span>
        <button
          type="button"
          onClick={() => setMonth(shiftMonth(month, 1))}
          disabled={month >= currentMonth}
          className="rounded-md border border-border px-3 py-1 text-sm hover:bg-surface disabled:opacity-40"
        >
          Next →
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && !statement && <p className="text-sm text-muted">Loading…</p>}

      {statement && (
        <>
          <section className="flex flex-col gap-3">
            {statement.lines.length === 0 ? (
              <p className="text-sm text-muted">No billable usage in {monthTitle(month)}.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted">
                      <th className="py-2 font-normal">Item</th>
                      <th className="py-2 text-right font-normal">Used</th>
                      <th className="py-2 text-right font-normal">Price</th>
                      <th className="py-2 text-right font-normal">Charge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {statement.lines.map((line) => (
                      <tr key={`${line.key}:${line.unitPriceCents}`} className="border-b border-border/50">
                        <td className="py-2">{line.label}</td>
                        <td className="py-2 text-right">
                          {formatUnits(line.units)} <span className="text-muted">× {line.unitLabel}</span>
                        </td>
                        <td className="py-2 text-right">{formatUnitPrice(line.unitPriceCents)}</td>
                        <td className="py-2 text-right">{formatMoney(line.chargeCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={3} className="py-3 font-medium">
                        Total
                      </td>
                      <td className="py-3 text-right font-semibold">{formatMoney(statement.totalCents)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            <p className="text-xs text-muted">
              Each use is charged at the price in effect when it happened, so a price change only affects usage from
              that moment on. Months are UTC calendar months.
            </p>
            {statement.unpricedEvents > 0 && (
              <p className="text-xs text-muted">
                {statement.unpricedEvents} use{statement.unpricedEvents === 1 ? "" : "s"} this month could not be priced
                and {statement.unpricedEvents === 1 ? "isn't" : "aren't"} included above.
              </p>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">Current prices</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {statement.currentPrices.map((price) => (
                <li key={price.key} className="flex justify-between">
                  <span>
                    {price.label} <span className="text-muted">per {price.unitLabel}</span>
                  </span>
                  <span>{price.unitPriceCents === null || price.unitPriceCents === 0 ? "Free" : `${price.unitPriceCents}¢`}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </main>
  );
}
