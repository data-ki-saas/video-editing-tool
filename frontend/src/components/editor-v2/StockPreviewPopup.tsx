"use client";

/**
 * The "check it in a popup" step for a video search result on
 * StockMediaDialog -- a small nested modal (higher z-index than the dialog
 * behind it) playing the actual preview file, with its own "Add to
 * project" button so importing doesn't require going back to the grid.
 * Never used for photos ("pictures are easy" -- the grid thumbnail already
 * is the check) or music (a native `<audio controls>` sits directly in
 * MusicResultRow instead -- see StockMediaDialog.tsx -- since a hidden-
 * behind-a-click preview step is more friction than something this
 * lightweight needs).
 */
import type { StockSearchResult } from "@/lib/api";

export function StockPreviewPopup({
  result,
  isImporting,
  isImported,
  onClose,
  onImport,
}: {
  result: StockSearchResult;
  isImporting: boolean;
  isImported: boolean;
  onClose: () => void;
  onImport: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${result.title}`}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      // stopPropagation here matters: this popup is a DOM child of
      // StockMediaDialog's own backdrop (which closes on any click) --
      // without this, clicking outside the preview would bubble up and
      // close BOTH popups instead of just this one.
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="truncate text-sm font-semibold">{result.title}</h3>
          <button type="button" onClick={onClose} aria-label="Close preview" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="flex items-center justify-center overflow-hidden rounded-md bg-black">
          <video src={result.preview_url} controls autoPlay className="max-h-[60vh] w-full" />
        </div>

        <p className="mt-2 text-[11px] text-muted">{result.attribution}</p>

        <button
          type="button"
          onClick={onImport}
          disabled={isImporting || isImported}
          className="mt-3 w-full rounded-md bg-accent py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {isImported ? "Added" : isImporting ? "Adding…" : "Add to project"}
        </button>
      </div>
    </div>
  );
}
