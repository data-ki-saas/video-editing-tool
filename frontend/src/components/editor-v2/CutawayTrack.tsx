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
import type { BackgroundRemovalState, CropRect } from "@/lib/video/video_math";
import { getImageTemplateOption } from "@/lib/video/imageTemplates";
import { getFilterPresetOption, type FilterPresetId } from "@/lib/video/filterPresets";
import { getCanvasFillOption, type CanvasFillMode } from "@/lib/video/canvasFillPresets";
import type { AmbientEffectId } from "@/lib/video/ambientEffects";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { MattingProgressBadge } from "./MattingProgressBadge";

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
      canvasFillMode: CanvasFillMode | null;
      canvasFillColor?: string;
      canvasFillGradientColor?: string;
      // AI background removal (see CutawayDialog.tsx's "Remove background"
      // toggle) -- enabled but matteAssetId still null means the matting
      // job is still processing (CutawaySegmentButton shows a small
      // "Processing…" badge for that state, see its own code below). A
      // photo's own job (rembg, synchronous) usually resolves fast enough
      // that this state is barely visible; a video's (VEED, async) can sit
      // here for a while.
      backgroundRemoval?: BackgroundRemovalState | null;
      // "Make it 3D" (lib/video/camera3D.ts) -- see CutawayDialog.tsx's own
      // toggle.
      camera3D?: boolean;
      // Ambient overlay effect (lib/video/ambientEffects.ts) -- see
      // CutawayDialog.tsx's own picker.
      ambientEffect?: AmbientEffectId | null;
    }
  | {
      kind: "video";
      entryId: string;
      assetId: string;
      startTimeSeconds: number;
      durationSeconds: number;
      colorFilterId: FilterPresetId | null;
      canvasFillMode: CanvasFillMode | null;
      canvasFillColor?: string;
      canvasFillGradientColor?: string;
      // Same AI background removal as the "image" variant above.
      backgroundRemoval?: BackgroundRemovalState | null;
    };

function CutawaySegmentButton({
  segment,
  toPercent,
  onEdit,
  onDelete,
  onOpenFilter,
  onOpenCanvasFill,
}: {
  segment: CutawaySegment;
  toPercent: (seconds: number) => number;
  onEdit: () => void;
  onDelete: () => void;
  onOpenFilter: () => void;
  onOpenCanvasFill: () => void;
}) {
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();
  const isImage = segment.kind === "image";
  const filterOption = segment.colorFilterId ? getFilterPresetOption(segment.colorFilterId) : null;
  const canvasFillOption = segment.canvasFillMode ? getCanvasFillOption(segment.canvasFillMode) : null;

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
            { label: "Canvas fill…", onSelect: onOpenCanvasFill },
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
        {canvasFillOption && (
          <span className="pointer-events-none shrink-0 truncate rounded-full bg-black/30 px-1 pr-1" title={canvasFillOption.name}>
            {canvasFillOption.name}
          </span>
        )}
        {segment.backgroundRemoval?.enabled && (
          segment.backgroundRemoval.matteAssetId ? (
            <span
              className="pointer-events-none shrink-0 truncate rounded-full bg-black/30 px-1 pr-1"
              title="Background removed"
            >
              ✂️
            </span>
          ) : (
            <MattingProgressBadge progress={segment.backgroundRemoval.progress ?? 0} />
          )
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
  onOpenCanvasFill,
}: {
  segments: CutawaySegment[];
  videoDurationSeconds: number;
  onEdit: (segment: CutawaySegment) => void;
  onDelete: (segment: CutawaySegment) => void;
  onOpenFilter: (segment: CutawaySegment) => void;
  onOpenCanvasFill: (segment: CutawaySegment) => void;
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
          onOpenCanvasFill={() => onOpenCanvasFill(segment)}
        />
      ))}
    </div>
  );
}
