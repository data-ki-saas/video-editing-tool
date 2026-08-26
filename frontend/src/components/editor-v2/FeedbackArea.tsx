"use client";

/**
 * Bottom band of the three-pane editor -- a single-line status strip.
 * Shows asset/analysis/save errors, upload/analysis progress, or render
 * progress -- whichever is most urgent, one at a time. The transformation
 * summary ("action list") and the render/settings/sign-out controls that
 * used to share this band now live in ActionArea's action-list column and
 * TopMenuBar respectively (see those files' own comments).
 */
const TERMINAL_RENDER_STATUSES = new Set(["completed", "failed"]);

export function FeedbackArea({
  assetsError,
  analysisError,
  saveError,
  isAnalyzing,
  isUploading,
  isRendering,
  renderStatus,
  renderUrl,
  renderError,
  isRenderStuck,
}: {
  assetsError: string | null;
  analysisError: string | null;
  saveError: string | null;
  isAnalyzing: boolean;
  isUploading: boolean;
  isRendering: boolean;
  renderStatus: string | null;
  renderUrl: string | null;
  renderError: string | null;
  isRenderStuck: boolean;
}) {
  const message = (() => {
    if (assetsError) return <span className="text-red-600">Couldn&apos;t load your videos: {assetsError}</span>;
    if (analysisError) return <span className="text-red-600">Couldn&apos;t analyze this video: {analysisError}</span>;
    if (saveError) return <span className="text-red-600">Couldn&apos;t save your changes: {saveError}</span>;
    if (isRendering) return <span className="text-muted">Starting render…</span>;
    if (renderStatus === "failed") {
      return <span className="text-red-600">Render failed{renderError ? `: ${renderError}` : ""}</span>;
    }
    if (renderStatus === "completed" && renderUrl) {
      return (
        <span className="text-foreground">
          Render ready —{" "}
          <a href={renderUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            watch or download
          </a>
        </span>
      );
    }
    if (renderStatus && !TERMINAL_RENDER_STATUSES.has(renderStatus)) {
      return (
        <span className="text-muted">
          Rendering… {isRenderStuck && "this is taking longer than usual"}
        </span>
      );
    }
    if (isUploading) return <span className="text-muted">Uploading…</span>;
    if (isAnalyzing) return <span className="text-muted">Analyzing video for the timeline preview…</span>;
    return <span className="text-muted">No issues to report.</span>;
  })();

  return (
    <div className="flex h-8 shrink-0 items-center overflow-hidden px-4 text-sm">
      <p className="truncate">{message}</p>
    </div>
  );
}
