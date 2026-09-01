"use client";

/**
 * A "shown below the timeline" indicator for one flip axis's toggle history
 * (see lib/video/video_math.ts's computeFlipSegments) -- a colored bar over
 * every time range where that axis is currently engaged. Unlike
 * ZoomEffectsTrack, nothing here is draggable: a flip toggle is set by
 * clicking the same colored handle on the active tile's crop rectangle
 * again (at whatever frame the playhead is on), not by manipulating this
 * row directly -- this row is otherwise just a readout of where that
 * clicking has landed so far. Right-clicking a segment opens a context menu
 * (same one ZoomEffectsTrack/ProjectList use) to delete it outright -- the
 * only other way to undo a flip is re-clicking the exact frame it started
 * on, which isn't always where the playhead still is.
 */
import { ContextMenu, useContextMenu } from "./ContextMenu";
import type { FlipSegment } from "@/lib/video/video_math";

export function FlipTrack({
  segments,
  videoDurationSeconds,
  colorClassName,
  title,
  deleteLabel,
  onDeleteSegment,
}: {
  segments: FlipSegment[];
  videoDurationSeconds: number;
  colorClassName: string;
  title: string;
  deleteLabel: string;
  onDeleteSegment: (segmentIndex: number) => void;
}) {
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();

  if (segments.length === 0) return null;

  return (
    <div className="relative h-1.5 w-full shrink-0">
      {segments.map((segment, index) => {
        const leftPercent = videoDurationSeconds > 0 ? (segment.startTimeSeconds / videoDurationSeconds) * 100 : 0;
        const widthPercent =
          videoDurationSeconds > 0
            ? ((segment.endTimeSeconds - segment.startTimeSeconds) / videoDurationSeconds) * 100
            : 0;
        return (
          <div
            key={index}
            title={`${title} -- right-click to delete`}
            onContextMenu={(e) =>
              openContextMenu(e, [{ label: deleteLabel, danger: true, onSelect: () => onDeleteSegment(index) }])
            }
            className={`absolute top-0 h-full cursor-context-menu rounded-sm ${colorClassName}`}
            style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
          />
        );
      })}
      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}
