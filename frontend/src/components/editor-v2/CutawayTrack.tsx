"use client";

/**
 * The Cutaways rail: one segment per image cutaway (a photo inserted into
 * the base sequence and animated via a Ken Burns template -- see
 * lib/video/imageTemplates.ts, added/edited from ImageTemplatesDialog).
 * Sits above TrimTrack (the Cut and Trim rail) per spec, below MarkerTrack.
 *
 * Read-only positioning -- a cutaway's timing still comes from FrameStrip's
 * own clip-boundary drag handle, same as every other clip seam, not from
 * this rail. This rail's only interaction is jumping back into
 * ImageTemplatesDialog to edit that cutaway's photo/animation/duration;
 * removing a cutaway from playback is still done the same way as removing
 * any other stretch of footage, via the Cut and Trim rail directly below.
 */
import { getImageTemplateOption } from "@/lib/video/imageTemplates";

export interface CutawaySegment {
  entryId: string;
  assetId: string;
  templateId: string;
  startTimeSeconds: number;
  durationSeconds: number;
}

export function CutawayTrack({
  segments,
  videoDurationSeconds,
  onEdit,
}: {
  segments: CutawaySegment[];
  videoDurationSeconds: number;
  onEdit: (segment: CutawaySegment) => void;
}) {
  if (segments.length === 0) return null;

  const toPercent = (seconds: number) => (videoDurationSeconds > 0 ? (seconds / videoDurationSeconds) * 100 : 0);

  return (
    <div className="relative mb-1 h-4 w-full shrink-0">
      {segments.map((segment) => (
        <button
          key={segment.entryId}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(segment);
          }}
          title={`Edit this cutaway -- ${getImageTemplateOption(segment.templateId).name}`}
          className="absolute top-0 flex h-full items-center overflow-hidden rounded-sm border border-accent bg-accent/30 text-[9px] leading-none text-accent hover:bg-accent/50"
          style={{
            left: `${toPercent(segment.startTimeSeconds)}%`,
            width: `${toPercent(segment.durationSeconds)}%`,
          }}
        >
          <span className="pointer-events-none truncate px-1">Cutaway</span>
        </button>
      ))}
    </div>
  );
}
