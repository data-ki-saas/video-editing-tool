"use client";

/**
 * "Browse stock media" popup, opened by AssetGallery's "+ Stock" button --
 * search Pexels (photos/videos) or Freesound (music, CC0-licensed only) and
 * import a result straight into this project's asset list, the same way an
 * uploaded file becomes one (see lib/api.ts's importStockAsset).
 *
 * Checking a result before adding it works differently per kind: a photo's
 * grid thumbnail already IS the check (no extra step). A video opens in its
 * own nested preview popup (StockPreviewPopup) since it needs real screen
 * space to actually watch. Music instead gets a plain native
 * `<audio controls>` player inline in its own row -- a hidden-behind-a-click
 * preview step is the wrong amount of friction for something this
 * lightweight; the player should just be sitting right there, visibly
 * playable, the moment a track shows up in the results.
 *
 * Video/music search is already limited server-side to sub-minute clips
 * (see backend/src/stock_media/service.py's MAX_CLIP_DURATION_SECONDS), so
 * every result shown here is short enough to import as-is.
 */
import { useState } from "react";
import { importStockAsset, searchStockMedia, type Asset, type StockMediaKind, type StockSearchResult } from "@/lib/api";
import { MusicNoteIcon } from "@/components/icons/UIIcons";
import { StockPreviewPopup } from "./StockPreviewPopup";

function AddButton({
  isImporting,
  isImported,
  onImport,
}: {
  isImporting: boolean;
  isImported: boolean;
  onImport: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onImport}
      disabled={isImporting || isImported}
      className="shrink-0 rounded-md bg-accent px-2 py-1 text-[10px] font-medium text-accent-foreground disabled:opacity-50"
    >
      {isImported ? "Added" : isImporting ? "…" : "Add"}
    </button>
  );
}

const KIND_TABS: { id: StockMediaKind; label: string }[] = [
  { id: "photo", label: "Photos" },
  { id: "video", label: "Videos" },
  { id: "music", label: "Music" },
];

function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const wholeSeconds = Math.round(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${(wholeSeconds % 60).toString().padStart(2, "0")}`;
}

/** Photo or video results -- a thumbnail grid tile. A photo imports
 * directly on click (the thumbnail already is the check); a video opens
 * StockPreviewPopup instead, since checking it needs real screen space. */
function ResultTile({
  result,
  isImporting,
  isImported,
  onPreview,
  onImport,
}: {
  result: StockSearchResult;
  isImporting: boolean;
  isImported: boolean;
  onPreview: () => void;
  onImport: () => void;
}) {
  const duration = formatDuration(result.duration_seconds);

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-md border border-border bg-background">
      <button
        type="button"
        onClick={result.kind === "photo" ? onImport : onPreview}
        title={result.kind === "photo" ? "Add to project" : "Preview before adding"}
        className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-neutral-900"
      >
        {result.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- a third-party thumbnail URL, not a Next-optimizable local/static asset
          <img src={result.thumbnail_url} alt={result.title} className="h-full w-full object-cover" />
        ) : (
          <span className="text-xs text-muted">No preview</span>
        )}
        {duration && (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] text-white">{duration}</span>
        )}
      </button>

      <div className="flex items-center justify-between gap-1 p-1.5">
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted" title={result.attribution}>
          {result.attribution}
        </span>
        <AddButton isImporting={isImporting} isImported={isImported} onImport={onImport} />
      </div>
    </div>
  );
}

/** A music result -- a full-width row with a native `<audio controls>`
 * player sitting directly in it, playable immediately with no extra click
 * to reveal it. Freesound gives no artwork, so MusicNoteIcon is purely
 * decorative here, not a preview trigger. */
function MusicResultRow({
  result,
  isImporting,
  isImported,
  onImport,
}: {
  result: StockSearchResult;
  isImporting: boolean;
  isImported: boolean;
  onImport: () => void;
}) {
  const duration = formatDuration(result.duration_seconds);

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-background p-2">
      <MusicNoteIcon className="h-5 w-5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={result.title}>
            {result.title}
          </span>
          {duration && <span className="shrink-0 text-[10px] text-muted">{duration}</span>}
        </div>
        <audio controls src={result.preview_url} className="mt-1 h-8 w-full" />
        <p className="mt-0.5 truncate text-[10px] text-muted" title={result.attribution}>
          {result.attribution}
        </p>
      </div>
      <AddButton isImporting={isImporting} isImported={isImported} onImport={onImport} />
    </div>
  );
}

export function StockMediaDialog({
  projectId,
  onImported,
  onImportingChange,
  onClose,
}: {
  projectId: string;
  onImported: (asset: Asset) => void;
  onImportingChange?: (isImporting: boolean) => void;
  onClose: () => void;
}) {
  const [activeKind, setActiveKind] = useState<StockMediaKind>("photo");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importingIds, setImportingIds] = useState<Set<string>>(new Set());
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const [previewResult, setPreviewResult] = useState<StockSearchResult | null>(null);

  function runSearch(kind: StockMediaKind, searchQuery: string, nextPage: number, append: boolean) {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setError(null);
    searchStockMedia(kind, searchQuery, nextPage)
      .then((response) => {
        setResults((prev) => (append ? [...prev, ...response.results] : response.results));
        setPage(response.page);
        setHasMore(response.has_more);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Search failed"))
      .finally(() => setIsSearching(false));
  }

  function handleSelectKind(kind: StockMediaKind) {
    setActiveKind(kind);
    setResults([]);
    setHasMore(false);
    setError(null);
    if (query.trim()) runSearch(kind, query, 1, false);
  }

  function handleSubmitSearch(e: React.FormEvent) {
    e.preventDefault();
    runSearch(activeKind, query, 1, false);
  }

  function handleImport(result: StockSearchResult) {
    setImportingIds((prev) => new Set(prev).add(result.id));
    onImportingChange?.(true);
    importStockAsset(projectId, result.kind, result.id, result.title)
      .then((asset) => {
        setImportedIds((prev) => new Set(prev).add(result.id));
        onImported(asset);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to add this item"))
      .finally(() => {
        setImportingIds((prev) => {
          const next = new Set(prev);
          next.delete(result.id);
          return next;
        });
        onImportingChange?.(false);
      });
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Browse stock media"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[80vh] w-full max-w-3xl flex-col rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Browse stock media</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="mb-2 flex gap-1">
          {KIND_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => handleSelectKind(tab.id)}
              className={
                "rounded-md px-3 py-1 text-xs font-medium " +
                (activeKind === tab.id ? "bg-accent text-accent-foreground" : "text-muted hover:bg-background")
              }
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmitSearch} className="mb-3 flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search stock ${activeKind === "music" ? "music" : activeKind + "s"}…`}
            className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
          <button
            type="submit"
            disabled={isSearching || !query.trim()}
            className="shrink-0 rounded-md bg-accent px-3 py-1 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            Search
          </button>
        </form>

        {error && <p className="mb-2 text-xs text-red-600">{error}</p>}

        <div className="flex-1 overflow-y-auto">
          {results.length === 0 && !isSearching && (
            <p className="text-center text-xs text-muted">
              {query.trim() ? "No results yet -- try a different search." : "Search to browse stock media."}
            </p>
          )}

          <div className={activeKind === "music" ? "flex flex-col gap-2" : "grid grid-cols-3 gap-2"}>
            {results.map((result) =>
              result.kind === "music" ? (
                <MusicResultRow
                  key={result.id}
                  result={result}
                  isImporting={importingIds.has(result.id)}
                  isImported={importedIds.has(result.id)}
                  onImport={() => handleImport(result)}
                />
              ) : (
                <ResultTile
                  key={result.id}
                  result={result}
                  isImporting={importingIds.has(result.id)}
                  isImported={importedIds.has(result.id)}
                  onPreview={() => setPreviewResult(result)}
                  onImport={() => handleImport(result)}
                />
              )
            )}
          </div>

          {isSearching && <p className="mt-2 text-center text-xs text-muted">Searching…</p>}

          {hasMore && !isSearching && (
            <button
              type="button"
              onClick={() => runSearch(activeKind, query, page + 1, true)}
              className="mt-3 w-full rounded-md border border-border py-1.5 text-xs text-muted hover:bg-background"
            >
              Load more
            </button>
          )}
        </div>
      </div>

      {previewResult && (
        <StockPreviewPopup
          result={previewResult}
          isImporting={importingIds.has(previewResult.id)}
          isImported={importedIds.has(previewResult.id)}
          onClose={() => setPreviewResult(null)}
          onImport={() => handleImport(previewResult)}
        />
      )}
    </div>
  );
}
