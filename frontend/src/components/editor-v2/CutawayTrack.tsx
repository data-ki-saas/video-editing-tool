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
 * A segment's WIDTH still comes from FrameStrip's own clip-boundary drag
 * handle, same as every other clip seam -- this rail can't change how long
 * a clip plays. Its POSITION IN THE SEQUENCE, though, is click-hold-drag
 * reorderable right here: press and drag a segment past a neighbor's
 * midpoint to preview swapping places with it, drop to commit (see
 * handleDragPointerDown below and transformations.ts's
 * applyMoveSequenceClip, which reflows every time-anchored selection --
 * zoom/pan, overlays, captions, trims -- so a reorder never silently
 * desyncs something already authored against the old order). Desktop-only;
 * MobileAssetStrip's own reorder is deliberately buttons, not drag -- see
 * that file's comment for why touch precision made a different call.
 *
 * Left-click (when it's not the end of a drag) only does anything for an
 * IMAGE segment (jumps back into CutawayDialog to edit that cutaway's
 * photo/animation/duration/crop -- a video segment has nothing authored to
 * edit in place, its duration is always just whatever the file actually
 * plays). Right-click always offers "Remove Cutaway" for either kind, which
 * (unlike trimming footage out of view) actually splices the clip out of
 * the sequence and closes the gap -- see transformations.ts's
 * applyDeleteSequenceClip.
 */
import { useRef, useState } from "react";
import type { BackgroundRemovalState, CropRect } from "@/lib/video/video_math";
import { getImageTemplateOption } from "@/lib/video/imageTemplates";
import { getFilterPresetOption, type FilterPresetId } from "@/lib/video/filterPresets";
import { getCanvasFillOption, type CanvasFillMode } from "@/lib/video/canvasFillPresets";
import type { AmbientEffectId } from "@/lib/video/ambientEffects";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { MattingProgressBadge } from "./MattingProgressBadge";

// Pixel movement, from the initial pointerdown, before a press-and-move
// counts as a drag rather than a click -- keeps a plain click still working
// for an image segment's "edit" and a plain right-click for the context
// menu. Deliberately small: this rail is thin, so a hair-trigger drag start
// feels more responsive than a click that occasionally needs a second try.
const DRAG_THRESHOLD_PX = 4;

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
  leftPercent,
  widthPercent,
  isDragging,
  onDragPointerDown,
  onEdit,
  onDelete,
  onOpenFilter,
  onOpenCanvasFill,
}: {
  segment: CutawaySegment;
  leftPercent: number;
  widthPercent: number;
  isDragging: boolean;
  onDragPointerDown: (e: React.PointerEvent) => void;
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
        onPointerDown={onDragPointerDown}
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
            ? `Drag to reorder -- ${segment.templateIds.map((id) => getImageTemplateOption(id).name).join(" + ")}; click to edit, right-click for more`
            : "Drag to reorder this video cutaway -- right-click for more"
        }
        className={
          "absolute top-0 flex h-full items-center gap-1 overflow-hidden rounded-sm border text-[9px] leading-none cursor-grab active:cursor-grabbing " +
          (isDragging ? "z-10 opacity-80 ring-2 ring-accent " : "transition-[left] duration-150 ") +
          (isImage
            ? "border-accent bg-accent/30 text-accent hover:bg-accent/50"
            : "border-neutral-500/70 bg-neutral-500/20 text-neutral-300 hover:bg-neutral-500/30")
        }
        style={{
          left: `${leftPercent}%`,
          width: `${widthPercent}%`,
          touchAction: "none",
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
  onReorder,
}: {
  segments: CutawaySegment[];
  videoDurationSeconds: number;
  onEdit: (segment: CutawaySegment) => void;
  onDelete: (segment: CutawaySegment) => void;
  onOpenFilter: (segment: CutawaySegment) => void;
  onOpenCanvasFill: (segment: CutawaySegment) => void;
  // Fires once on drop (never for a plain click/right-click) with the full
  // segment list -- so the caller can read each one's own resolved
  // startTimeSeconds/durationSeconds without a separate duration probe --
  // and the dragged entry's new index, Array.splice "move" semantics (see
  // transformations.ts's applyMoveSequenceClip, which this is built for).
  onReorder: (segments: CutawaySegment[], entryId: string, toIndex: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  // Whether the pointer actually moved past DRAG_THRESHOLD_PX during the
  // current press -- read by each segment's onClick to swallow the click a
  // real drag's pointerup still generates, without touching state (a ref so
  // checking it doesn't itself trigger a render). Reset at the START of
  // every new pointerdown, not at drop, so the click this same drag's
  // pointerup generates still sees it as true.
  const didDragRef = useRef(false);
  const [dragPreviewOrder, setDragPreviewOrder] = useState<string[] | null>(null);
  const [draggingEntryId, setDraggingEntryId] = useState<string | null>(null);

  if (segments.length === 0) return null;

  const toPercent = (seconds: number) => (videoDurationSeconds > 0 ? (seconds / videoDurationSeconds) * 100 : 0);

  // While a drag is live, left offsets preview the reordered sequence --
  // every segment keeps its OWN durationSeconds (a reorder never changes
  // how long a clip plays, only when), so each one's previewed position is
  // just a running sum of durations in whatever order is currently hovered.
  const orderedSegments = dragPreviewOrder
    ? (dragPreviewOrder.map((id) => segments.find((s) => s.entryId === id)).filter(Boolean) as CutawaySegment[])
    : segments;
  let cursorSeconds = 0;
  const leftPercentByEntryId = new Map<string, number>();
  for (const segment of orderedSegments) {
    leftPercentByEntryId.set(segment.entryId, toPercent(cursorSeconds));
    cursorSeconds += segment.durationSeconds;
  }

  function handleDragPointerDown(e: React.PointerEvent, entryId: string) {
    if (e.button !== 0) return;
    const startClientX = e.clientX;
    didDragRef.current = false;
    let previewOrder = segments.map((s) => s.entryId);

    function handleMove(ev: PointerEvent) {
      if (!didDragRef.current) {
        if (Math.abs(ev.clientX - startClientX) < DRAG_THRESHOLD_PX) return;
        didDragRef.current = true;
        setDraggingEntryId(entryId);
      }

      const trackRect = trackRef.current?.getBoundingClientRect();
      if (!trackRect || trackRect.width <= 0 || videoDurationSeconds <= 0) return;
      const percent = ((ev.clientX - trackRect.left) / trackRect.width) * 100;
      const timeSeconds = (percent / 100) * videoDurationSeconds;

      // Hover slot: walk the ORIGINAL (not preview) segment order/durations
      // -- a stable reference frame recomputed fresh from `segments` on
      // every move, so a fast drag across several slots never accumulates
      // drift off a stale preview order.
      let hoverIndex = segments.length - 1;
      let accSeconds = 0;
      for (let i = 0; i < segments.length; i++) {
        const durationSeconds = segments[i].durationSeconds;
        if (timeSeconds < accSeconds + durationSeconds / 2) {
          hoverIndex = i;
          break;
        }
        accSeconds += durationSeconds;
      }

      const fromIndex = segments.findIndex((s) => s.entryId === entryId);
      const nextOrder = segments.map((s) => s.entryId);
      const [movedId] = nextOrder.splice(fromIndex, 1);
      nextOrder.splice(Math.max(0, Math.min(hoverIndex, nextOrder.length)), 0, movedId);
      previewOrder = nextOrder;
      setDragPreviewOrder(nextOrder);
    }

    function handleUp() {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      setDragPreviewOrder(null);
      setDraggingEntryId(null);
      if (didDragRef.current) {
        const toIndex = previewOrder.indexOf(entryId);
        const fromIndex = segments.findIndex((s) => s.entryId === entryId);
        if (toIndex !== -1 && toIndex !== fromIndex) onReorder(segments, entryId, toIndex);
      }
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  return (
    <div ref={trackRef} className="relative mb-1 h-4 w-full shrink-0">
      {segments.map((segment) => (
        <CutawaySegmentButton
          key={segment.entryId}
          segment={segment}
          leftPercent={leftPercentByEntryId.get(segment.entryId) ?? toPercent(segment.startTimeSeconds)}
          widthPercent={toPercent(segment.durationSeconds)}
          isDragging={draggingEntryId === segment.entryId}
          onDragPointerDown={(e) => handleDragPointerDown(e, segment.entryId)}
          onEdit={() => {
            if (didDragRef.current) return;
            onEdit(segment);
          }}
          onDelete={() => onDelete(segment)}
          onOpenFilter={() => onOpenFilter(segment)}
          onOpenCanvasFill={() => onOpenCanvasFill(segment)}
        />
      ))}
    </div>
  );
}
