"use client";

/**
 * Bottom band of the three-pane editor. Left: a live summary of every
 * transformation currently ACTIVE on the clip -- the clip rectangle, each
 * zoom/pan transition, and every flip/mirror window -- not a log of every
 * click that got it there. Undo/redo (Ctrl+Z/Ctrl+Y, see
 * ThreePaneEditor.tsx) still walks that click-by-click history underneath
 * (lib/useEditHistory.ts); this panel just doesn't surface the history
 * itself, only what it currently adds up to. Right: status/errors from the
 * asset list and the thumbnail/volume analysis pipeline.
 */
import { CLIP_RECT_OPTIONS } from "./ClipRectIcon";
import { computeFlipSegments } from "@/lib/video/video_math";
import type { EditSelectionsSnapshot } from "@/lib/projects";

function formatTimeRange(startTimeSeconds: number, endTimeSeconds: number): string {
  const format = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const wholeSeconds = Math.floor(seconds % 60);
    return `${minutes}:${wholeSeconds.toString().padStart(2, "0")}`;
  };
  return `${format(startTimeSeconds)}–${format(endTimeSeconds)}`;
}

function ActiveTransformationsList({
  selections,
  videoDurationSeconds,
}: {
  selections: EditSelectionsSnapshot;
  videoDurationSeconds: number;
}) {
  const rows: string[] = [];

  if (selections.clipRectId) {
    const option = CLIP_RECT_OPTIONS.find((candidate) => candidate.id === selections.clipRectId);
    rows.push(`Clip rectangle: ${option?.ratioLabel ?? selections.clipRectId}`);
  }
  for (const effect of selections.zoomEffects) {
    rows.push(`Zoom/pan ${formatTimeRange(effect.startTimeSeconds, effect.endTimeSeconds)}`);
  }
  for (const segment of computeFlipSegments(selections.flipHorizontalToggles, videoDurationSeconds)) {
    rows.push(`Flipped ${formatTimeRange(segment.startTimeSeconds, segment.endTimeSeconds)}`);
  }
  for (const segment of computeFlipSegments(selections.flipVerticalToggles, videoDurationSeconds)) {
    rows.push(`Mirrored ${formatTimeRange(segment.startTimeSeconds, segment.endTimeSeconds)}`);
  }

  if (rows.length === 0) {
    return <p className="text-xs text-muted">No transformations applied yet.</p>;
  }

  return (
    <ul className="flex h-full flex-col gap-0.5 overflow-y-auto">
      {rows.map((row, index) => (
        <li key={index} className="truncate rounded-md px-2 py-0.5 text-xs text-foreground">
          {row}
        </li>
      ))}
    </ul>
  );
}

export function FeedbackArea({
  assetsError,
  analysisError,
  saveError,
  isAnalyzing,
  isUploading,
  selections,
  videoDurationSeconds,
}: {
  assetsError: string | null;
  analysisError: string | null;
  saveError: string | null;
  isAnalyzing: boolean;
  isUploading: boolean;
  selections: EditSelectionsSnapshot;
  videoDurationSeconds: number;
}) {
  const hasMessages = assetsError || analysisError || saveError || isAnalyzing || isUploading;

  return (
    <div className="flex h-full gap-4 px-4 py-2 text-sm">
      <div className="w-64 shrink-0 overflow-hidden border-r border-border pr-4">
        <ActiveTransformationsList selections={selections} videoDurationSeconds={videoDurationSeconds} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        {!hasMessages && <p className="text-muted">No issues to report.</p>}
        {assetsError && <p className="text-red-600">Couldn&apos;t load your videos: {assetsError}</p>}
        {analysisError && <p className="text-red-600">Couldn&apos;t analyze this video: {analysisError}</p>}
        {saveError && <p className="text-red-600">Couldn&apos;t save your changes: {saveError}</p>}
        {isUploading && <p className="text-muted">Uploading…</p>}
        {isAnalyzing && !analysisError && <p className="text-muted">Analyzing video for the timeline preview…</p>}
      </div>
    </div>
  );
}
