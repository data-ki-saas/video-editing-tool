"use client";

/**
 * The Cutaways rail: one segment per clip in the base sequence -- an image
 * cutaway (a photo inserted into the sequence and animated via a Ken Burns
 * template -- see lib/video/imageTemplates.ts, added/edited from
 * CutawayDialog) AND, since "Append" was folded into "Cutaway" (both are
 * the same underlying operation -- appending a SequenceEntry), every plain
 * video clip too. Sits above TrimTrack (the Cut and Trim rail) per spec,
 * below MarkerTrack.
 *
 * Read-only positioning -- a segment's timing still comes from FrameStrip's
 * own clip-boundary drag handle, same as every other clip seam, not from
 * this rail. Left-click only does anything for an IMAGE segment (jumps back
 * into CutawayDialog to edit that cutaway's photo/animation/duration/crop --
 * a video segment has nothing authored to edit in place, its duration is
 * always just whatever the file actually plays). Right-click always offers
 * "Remove Cutaway" for either kind, which (unlike trimming footage out of
 * view) actually splices the clip out of the sequence and closes the gap --
 * see transformations.ts's applyDeleteSequenceClip.
 */
import type { CropRect } from "@/lib/video/video_math";
import { getImageTemplateOption } from "@/lib/video/imageTemplates";
import { getFilterPresetOption, type FilterPresetId } from "@/lib/video/filterPresets";
import { ContextMenu, useContextMenu } from "./ContextMenu";

export type CutawaySegment =
  | {
      kind: "image";
      entryId: string;
      assetId: string;
      templateIds: string[];
      // The clip rectangle positioned for this photo (fractions of the
      // photo itself, see video_math.ts's SequenceEntry image variant) --
      // null only for cutaways persisted before this field existed.
      cropRect: CropRect | null;
      startTimeSeconds: number;
      durationSeconds: number;
      colorFilterId: FilterPresetId | null;
    }
  | {
      kind: "video";
      entryId: string;
      assetId: string;
      startTimeSeconds: number;
      durationSeconds: number;
      colorFilterId: FilterPresetId | null;
    };

function CutawaySegmentButton({
  segment,
  toPercent,
  onEdit,
  onDelete,
  onOpenFilter,
}: {
  segment: CutawaySegment;
  toPercent: (seconds: number) => number;
  onEdit: () => void;
  onDelete: () => void;
  onOpenFilter: () => void;
}) {
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();
  const isImage = segment.kind === "image";
  const filterOption = segment.colorFilterId ? getFilterPresetOption(segment.colorFilterId) : null;

  return (
    <>
      <button
        type="button"
        onClick={
          isImage
            ? (e) => {
                e.stopPropagation();
                onEdit();
              }
            : undefined
        }
        onContextMenu={(e) =>
          openContextMenu(e, [
            { label: "Filter…", onSelect: onOpenFilter },
            { label: "Remove Cutaway", danger: true, onSelect: onDelete },
          ])
        }
        title={
          segment.kind === "image"
            ? `Edit this cutaway -- ${segment.templateIds.map((id) => getImageTemplateOption(id).name).join(" + ")}; right-click for more`
            : "Video cutaway -- right-click for more"
        }
        className={
          "absolute top-0 flex h-full items-center gap-1 overflow-hidden rounded-sm border text-[9px] leading-none " +
          (isImage
            ? "cursor-pointer border-accent bg-accent/30 text-accent hover:bg-accent/50"
            : "cursor-default border-neutral-500/70 bg-neutral-500/20 text-neutral-300 hover:bg-neutral-500/30")
        }
        style={{
          left: `${toPercent(segment.startTimeSeconds)}%`,
          width: `${toPercent(segment.durationSeconds)}%`,
        }}
      >
        <span className="pointer-events-none shrink-0 pl-1">{isImage ? "🖼" : "▶"}</span>
        <span className="pointer-events-none truncate pr-1">Cutaway</span>
        {filterOption && (
          <span className="pointer-events-none shrink-0 truncate rounded-full bg-black/30 px-1 pr-1" title={filterOption.name}>
            {filterOption.name}
          </span>
        )}
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
  onOpenFilter,
}: {
  segments: CutawaySegment[];
  videoDurationSeconds: number;
  onEdit: (segment: CutawaySegment) => void;
  onDelete: (segment: CutawaySegment) => void;
  onOpenFilter: (segment: CutawaySegment) => void;
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
          onOpenFilter={() => onOpenFilter(segment)}
        />
      ))}
    </div>
  );
}
