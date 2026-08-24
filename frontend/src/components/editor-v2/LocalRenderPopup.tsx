"use client";

/**
 * Shown while and after "Edge Render" (the free/local render) runs (see
 * lib/localRender/exportTimeline.ts, wired up in ThreePaneEditor.tsx's
 * handleLocalRenderClick) -- a loader while exporting, then the finished
 * video with native play/pause/seek controls plus an explicit Download
 * button (the blob URL only lives as long as this tab stays open, unlike
 * the cloud render's permanent R2 link, so downloading it is the only way
 * to keep it). Same small-modal chrome as StockPreviewPopup.tsx, except it
 * can't be dismissed mid-render -- there's nothing productive to do with it
 * closed (the render keeps running either way, and reopening it would risk
 * a confusing second click starting a second export).
 */
export function LocalRenderPopup({
  isRendering,
  progress,
  resultUrl,
  resultMimeType,
  resultError,
  resultWarnings,
  onClose,
}: {
  isRendering: boolean;
  progress: number;
  resultUrl: string | null;
  resultMimeType: string | null;
  resultError: string | null;
  resultWarnings: string[];
  onClose: () => void;
}) {
  const isDismissable = !isRendering;
  const fileExtension = resultMimeType === "video/webm" ? "webm" : "mp4";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edge Render"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={isDismissable ? onClose : undefined}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">Edge Render</h3>
          {isDismissable && (
            <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
              ✕
            </button>
          )}
        </div>

        {isRendering && (
          <div className="flex flex-col items-center gap-3 py-10">
            <svg viewBox="0 0 24 24" className="h-10 w-10 animate-spin text-accent" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="2.2" />
              <circle cx="12" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="16.8" cy="14.8" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="7.2" cy="14.8" r="1.4" fill="currentColor" stroke="none" />
            </svg>
            <p className="text-sm text-muted">Exporting… {Math.round(progress * 100)}%</p>
          </div>
        )}

        {!isRendering && resultError && (
          <p className="text-sm text-red-600">Edge Render failed: {resultError}</p>
        )}

        {!isRendering && resultUrl && (
          <div className="flex flex-col gap-3">
            <video
              src={resultUrl}
              controls
              autoPlay
              className="max-h-[60vh] w-full rounded-md bg-black"
            />
            {resultWarnings.length > 0 && (
              <ul className="flex flex-col gap-1 rounded-md bg-yellow-100 p-2 text-xs text-yellow-800">
                {resultWarnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            )}
            <a
              href={resultUrl}
              download={`reel.${fileExtension}`}
              className="rounded-md bg-accent py-1.5 text-center text-sm font-medium text-accent-foreground hover:opacity-90"
            >
              Download
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
