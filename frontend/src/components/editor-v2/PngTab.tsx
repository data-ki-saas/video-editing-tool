"use client";

/**
 * "PNG" tab of PropsDialog -- live search for transparent cut-outs (a car, a
 * coffee cup, a rocket...) on Wikimedia Commons, via our own backend
 * (backend/src/png_search). Commons rather than CleanPNG: CleanPNG only
 * publishes white-background previews and gates the real file behind a bot
 * challenge. Every result is open-licensed, so each tile carries its licence and
 * the dialog shows the credit line for the one being placed.
 *
 * Picking one imports it into the project (the backend re-resolves the file by
 * id and rejects any that turn out to have a solid background), after which it
 * travels the same place-as-image-overlay path as every other prop.
 */
import { useEffect, useState } from "react";
import { searchPngs, type PngSearchResult } from "@/lib/api";

const DEFAULT_QUERY = "rocket";

// A light checkerboard, so a cut-out's transparent areas read as "see-through".
const CHECKERBOARD_STYLE: React.CSSProperties = {
  backgroundColor: "#e5e5e5",
  backgroundImage:
    "linear-gradient(45deg, #cfcfcf 25%, transparent 25%, transparent 75%, #cfcfcf 75%), linear-gradient(45deg, #cfcfcf 25%, transparent 25%, transparent 75%, #cfcfcf 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 8px 8px",
};

export function PngTab({
  placingKey,
  onPlace,
}: {
  // Id of the PNG currently being imported (disables the grid), or null.
  placingKey: string | null;
  onPlace: (result: PngSearchResult) => void;
}) {
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [debouncedQuery, setDebouncedQuery] = useState(DEFAULT_QUERY);
  // "Show more" loads the page after the one already shown for this query.
  const [page, setPage] = useState({ query: DEFAULT_QUERY, number: 1 });
  const [result, setResult] = useState<{
    key: string;
    items: PngSearchResult[];
    hasMore: boolean;
    error: string | null;
  } | null>(null);

  const pageNumber = page.query === debouncedQuery ? page.number : 1;
  const requestKey = `${debouncedQuery}|${pageNumber}`;

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 400);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!debouncedQuery) return;
    const controller = new AbortController();
    searchPngs(debouncedQuery, pageNumber, controller.signal)
      .then((found) => {
        setResult((previous) => {
          const earlier = pageNumber === 1 ? [] : (previous?.items ?? []);
          const seen = new Set(earlier.map((item) => item.id));
          return {
            key: requestKey,
            items: [...earlier, ...found.results.filter((item) => !seen.has(item.id))],
            hasMore: found.has_more,
            error: null,
          };
        });
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setResult((previous) => ({
          key: requestKey,
          items: pageNumber === 1 ? [] : (previous?.items ?? []),
          hasMore: false,
          error: err instanceof Error ? err.message : "PNG search failed",
        }));
      });
    return () => controller.abort();
  }, [debouncedQuery, pageNumber, requestKey]);

  const isLoading = debouncedQuery !== "" && result?.key !== requestKey;
  const items = debouncedQuery ? (result?.items ?? []) : [];
  const error = debouncedQuery ? (result?.error ?? null) : null;
  const placing = items.find((item) => item.id === placingKey);

  return (
    <>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search transparent PNGs (e.g. rocket, coffee cup, dog)"
        className="mb-2 w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
      />
      <p className="mb-2 text-[11px] text-muted">
        Click a PNG to place it like a prop. Results are openly licensed from Wikimedia Commons -- hover one for its licence.
        Some need a credit if you publish.
      </p>

      {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

      <div className="flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <p className="text-center text-xs text-muted">
            {isLoading ? "Searching…" : debouncedQuery ? "No transparent PNGs match. Try a simpler word." : "Type to search."}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-2">
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onPlace(item)}
                  disabled={placingKey !== null}
                  title={item.attribution}
                  className="flex w-full flex-col overflow-hidden rounded-md border border-border bg-background text-left hover:border-accent disabled:opacity-60"
                >
                  <span className="flex aspect-square w-full items-center justify-center p-2" style={CHECKERBOARD_STYLE}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a third-party Commons thumbnail, not a Next-optimizable asset */}
                    <img src={item.thumbnail_url} alt={item.title} loading="lazy" className="max-h-full max-w-full object-contain" />
                  </span>
                  <span className="truncate px-1.5 pt-1 text-xs font-medium text-foreground">
                    {placingKey === item.id ? "Adding…" : item.title}
                  </span>
                  <span className="truncate px-1.5 pb-1 text-[10px] text-muted">{item.license}</span>
                </button>
              ))}
            </div>
            {result?.hasMore && (
              <button
                type="button"
                disabled={isLoading}
                onClick={() => setPage({ query: debouncedQuery, number: pageNumber + 1 })}
                className="mx-auto mt-3 block rounded-md border border-border px-3 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
              >
                {isLoading ? "Loading…" : "Show more"}
              </button>
            )}
          </>
        )}
        {placing && <p className="mt-3 text-center text-[10px] text-muted">{placing.attribution}</p>}
      </div>
    </>
  );
}
