"use client";

/**
 * Bottom band of the three-pane editor -- one row, two zones. Left: the
 * single most-urgent status (errors, upload/analysis/render progress),
 * exactly as before -- pinned, not scrolling, whichever is most pressing.
 * Right: a chatty, continuously-updating activity ticker (`activityLog`).
 *
 * Some background jobs -- fal.ai's VEED background-removal integration in
 * particular, see lib/backgroundRemoval.ts's own module comment -- are
 * webhook-only from the provider's side: this app has no real interim
 * progress to show, only "still waiting" or a terminal result. Left
 * entirely silent, that reads as "is this even doing anything?" (its own
 * MattingProgressBadge helps, but it's a small badge tucked onto one rail
 * segment, easy to miss). Every poll tick gets logged here instead, so the
 * strip itself proves the app is actively checking in with the backend
 * even while the actual work is still a black box.
 *
 * New entries are appended (oldest-to-newest, left-to-right); the strip
 * snaps its own scroll position to the newest one on every change (a plain
 * `scrollLeft` assignment, not `scrollTo({behavior:"smooth"})` -- that
 * turned out unreliable on a flex+overflow-x row, sometimes never
 * completing rather than just skipping the animation) and each entry fades/
 * slides in from the right as it mounts (globals.css's `log-entry-enter`),
 * so the "feels alive, flowing in from the right" motion comes from the
 * per-entry animation rather than the container's own scroll animating.
 */
import { useEffect, useRef } from "react";

const TERMINAL_RENDER_STATUSES = new Set(["completed", "failed"]);

export interface ActivityLogEntry {
  id: number;
  text: string;
}

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
  activityLog,
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
  // Chatty background-activity feed -- see this file's own module comment.
  // Oldest-first; ThreePaneEditor caps its own length, this component just
  // renders whatever it's handed.
  activityLog: ActivityLogEntry[];
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

  const tickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = tickerRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
  }, [activityLog]);

  return (
    <div className="flex h-8 shrink-0 items-center gap-3 overflow-hidden px-4 text-sm">
      <p className="shrink-0 max-w-[45%] truncate">{message}</p>
      {activityLog.length > 0 && (
        <>
          <span className="h-4 w-px shrink-0 bg-border" />
          <div ref={tickerRef} className="hide-scrollbar flex min-w-0 flex-1 items-center gap-4 overflow-x-auto">
            {activityLog.map((entry) => (
              <span key={entry.id} className="log-entry-enter shrink-0 whitespace-nowrap text-xs text-muted">
                {entry.text}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
