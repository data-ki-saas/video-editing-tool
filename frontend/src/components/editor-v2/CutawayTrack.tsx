"use client";

/**
 * The Cutaways rail: one segment per image cutaway (a photo inserted into
 * the base sequence and animated via a Ken Burns template -- see
 * lib/video/imageTemplates.ts, added/edited from ImageTemplatesDialog).
 * Sits above TrimTrack (the Cut and Trim rail) per spec, below MarkerTrack.
 *
 * Read-only positioning -- a cutaway's timing still comes from FrameStrip's
 * own clip-boundary drag handle, same as every other clip seam, not from
 * this rail. Left-click jumps back into ImageTemplatesDialog to edit that
 * cutaway's photo/animation/duration; right-click offers "Remove Cutaway",
 * which (unlike trimming footage out of view) actually splices the clip out
 * of the sequence and closes the gap -- see transformations.ts's
 * applyDeleteImageSequenceClip.
 */
import { getImageTemplateOption } from "@/lib/video/imageTemplates";
import type { CropRect } from "@/lib/video/video_math";
import { ContextMenu, useContextMenu } from "./ContextMenu";

export interface CutawaySegment {
  entryId: string;
  assetId: string;
  templateIds: string[];
  // The clip rectangle positioned for this photo (fractions of the photo
  // itself, see video_math.ts's SequenceEntry image variant) -- null only
  // for cutaways persisted before this field existed.
  cropRect: CropRect | null;
  startTimeSeconds: number;
  durationSeconds: number;
}

function CutawaySegmentButton({
  segment,
  toPercent,
  onEdit,
  onDelete,
}: {
  segment: CutawaySegment;
  toPercent: (seconds: number) => number;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        onContextMenu={(e) => openContextMenu(e, [{ label: "Remove Cutaway", danger: true, onSelect: onDelete }])}
        title={`Edit this cutaway -- ${segment.templateIds.map((id) => getImageTemplateOption(id).name).join(" + ")}; right-click to remove`}
        className="absolute top-0 flex h-full items-center overflow-hidden rounded-sm border border-accent bg-accent/30 text-[9px] leading-none text-accent hover:bg-accent/50"
        style={{
          left: `${toPercent(segment.startTimeSeconds)}%`,
          width: `${toPercent(segment.durationSeconds)}%`,
        }}
      >
        <span className="pointer-events-none truncate px-1">Cutaway</span>
      </button>
      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </>
  );
}

export function CutawayTrack({
  segments,
  videoDurationSeconds,
  onEdit,
  onDelete,
}: {
  segments: CutawaySegment[];
  videoDurationSeconds: number;
  onEdit: (segment: CutawaySegment) => void;
  onDelete: (segment: CutawaySegment) => void;
}) {
  if (segments.length === 0) return null;

  const toPercent = (seconds: number) => (videoDurationSeconds > 0 ? (seconds / videoDurationSeconds) * 100 : 0);

  return (
    <div className="relative mb-1 h-4 w-full shrink-0">
      {segments.map((segment) => (
        <CutawaySegmentButton
          key={segment.entryId}
          segment={segment}
          toPercent={toPercent}
          onEdit={() => onEdit(segment)}
          onDelete={() => onDelete(segment)}
        />
      ))}
    </div>
  );
}
