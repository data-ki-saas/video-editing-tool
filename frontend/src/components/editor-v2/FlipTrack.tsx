"use client";

/**
 * A read-only "shown below the timeline" indicator for one flip axis's
 * toggle history (see lib/video/video_math.ts's computeFlipSegments) -- a
 * colored bar over every time range where that axis is currently engaged.
 * Unlike ZoomEffectsTrack, nothing here is draggable: a flip toggle is set
 * by clicking the same colored handle on the active tile's crop rectangle
 * again (at whatever frame the playhead is on), not by manipulating this
 * row directly -- this row is purely a readout of where that clicking has
 * landed so far.
 */
import type { FlipSegment } from "@/lib/video/video_math";

export function FlipTrack({
  segments,
  videoDurationSeconds,
  colorClassName,
  title,
}: {
  segments: FlipSegment[];
  videoDurationSeconds: number;
  colorClassName: string;
  title: string;
}) {
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
            title={title}
            className={`absolute top-0 h-full rounded-sm ${colorClassName}`}
            style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
          />
        );
      })}
    </div>
  );
}
