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
 * A segment's own clip BOUNDARIES (its position in the sequence relative to
 * its neighbors) still come from FrameStrip's own clip-boundary drag handle
 * -- this rail can't move a seam. What a segment DISPLAYS, though, can now
 * be narrower than its full boundary span on either edge -- see the small
 * handles at each segment's own left/right edge, dragged to trim from the
 * start or end respectively. An image/text segment's own authored duration
 * just shrinks/grows in place (applyResizeImageClip/applyResizeTextClip,
 * reflowing everything after it, same as FrameStrip's older boundary-drag
 * handle already did) -- but a VIDEO segment has no authored duration to
 * shrink (only ever the probed source file's own length), so trimming one
 * instead cuts a TrimRange at that edge (applyTrimCutawayHead/
 * applyTrimCutawayTail) -- the exact same cut-and-skip TrimTrack's own
 * two-click gesture already uses, just from a drag. A trimmed video edge
 * shows as a jagged/torn silhouette (see buildCutawayClipPath below) rather
 * than a plain straight edge, and right-click offers "Restore trimmed
 * start"/"Restore trimmed end" to undo it without re-dragging back out by
 * hand.
 *
 * A segment's POSITION IN THE SEQUENCE is click-hold-drag reorderable right
 * here: press and drag a segment past a neighbor's midpoint to preview
 * swapping places with it, drop to commit (see handleDragPointerDown below
 * and transformations.ts's applyMoveSequenceClip, which reflows every
 * time-anchored selection -- zoom/pan, overlays, captions, trims -- so a
 * reorder never silently desyncs something already authored against the old
 * order). Desktop-only; MobileAssetStrip's own reorder is deliberately
 * buttons, not drag -- see that file's comment for why touch precision made
 * a different call.
 *
 * Left-click (when it's not the end of a drag) only does anything for an
 * IMAGE or TEXT segment (jumps back into CutawayDialog/TextSlideDialog to
 * edit that cutaway's content in place -- a video segment has nothing else
 * authored to edit). Right-click always offers "Remove Cutaway" for any
 * kind, which (unlike trimming footage out of view) actually splices the
 * clip out of the sequence and closes the gap -- see transformations.ts's
 * applyDeleteSequenceClip.
 *
 * This rail is ALSO a drop target for a brand-new Text Slide dragged in
 * from UserActions.tsx's own toolbar button (native HTML5 drag-and-drop,
 * not the click-hold-drag reorder above -- see NEW_CUTAWAY_DRAG_TYPE,
 * handleTrackDragOver/handleTrackDrop, and insertIndexForClientX). Dropping
 * doesn't insert anything by itself -- text content can't come from a drag
 * gesture -- it just tells ThreePaneEditor's TextSlideDialog where to place
 * the slide once the user actually saves it, same dialog the toolbar
 * button's plain click already opens.
 */
import { useRef, useState } from "react";
import type { BackgroundRemovalState, CropRect } from "@/lib/video/video_math";
import { getImageTemplateOption } from "@/lib/video/imageTemplates";
import { getFilterPresetOption, type FilterPresetId } from "@/lib/video/filterPresets";
import { getCanvasFillOption, type CanvasFillMode } from "@/lib/video/canvasFillPresets";
import type { AmbientEffectId } from "@/lib/video/ambientEffects";
import type { FaceEffectId } from "@/lib/video/faceLandmarks";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { MattingProgressBadge } from "./MattingProgressBadge";
import {
  MIN_IMAGE_CLIP_DURATION_SECONDS,
  MAX_IMAGE_CLIP_DURATION_SECONDS,
  MIN_VIDEO_CUTAWAY_DURATION_SECONDS,
  type TextSlideLayout,
  type TextSlideStyle,
} from "@/lib/video/transformations";
import type { TextSlideTransitionId } from "@/lib/video/textSlideTransitions";

// Pixel movement, from the initial pointerdown, before a press-and-move
// counts as a drag rather than a click -- keeps a plain click still working
// for an image segment's "edit" and a plain right-click for the context
// menu. Deliberately small: this rail is thin, so a hair-trigger drag start
// feels more responsive than a click that occasionally needs a second try.
const DRAG_THRESHOLD_PX = 4;

// dataTransfer type for an external (native HTML5 DnD) drag of a brand-new
// cutaway onto this rail -- currently only the Text Slide toolbar button in
// UserActions.tsx sets this (see its own onDragStart). Kept as a named
// constant rather than a raw string literal so a future second draggable
// source (e.g. an asset tile) can share the same drop handling below just
// by setting the same key.
export const NEW_CUTAWAY_DRAG_TYPE = "application/x-ffmpeg-new-cutaway";

// A jagged/torn silhouette for whichever edge(s) of a VIDEO segment carry an
// active head/tail TrimRange -- visually distinguishes "this footage
// actually continues past what's shown, cut off here" from an image/text
// segment's plain straight edge (its whole authored duration IS what's
// shown, nothing hidden past it). Returns undefined when neither edge is
// trimmed, so an untrimmed segment keeps its ordinary rectangular box with
// no clip-path at all.
function buildCutawayClipPath(jaggedLeft: boolean, jaggedRight: boolean): string | undefined {
  if (!jaggedLeft && !jaggedRight) return undefined;
  const rightEdge: [number, number][] = jaggedRight
    ? [
        [100, 0],
        [90, 16.6],
        [100, 33.3],
        [90, 50],
        [100, 66.6],
        [90, 83.3],
        [100, 100],
      ]
    : [
        [100, 0],
        [100, 100],
      ];
  const leftEdge: [number, number][] = jaggedLeft
    ? [
        [0, 100],
        [10, 83.3],
        [0, 66.6],
        [10, 50],
        [0, 33.3],
        [10, 16.6],
        [0, 0],
      ]
    : [
        [0, 100],
        [0, 0],
      ];
  // Traces the box clockwise from its own top-left corner: across the top
  // edge, down the right edge (jagged or straight), across the bottom edge,
  // then up the left edge (jagged or straight) -- leftEdge's own last point
  // is dropped since it's the same top-left corner the path already opened
  // with (polygon() closes the path back to its first point automatically).
  const points = [[0, 0] as [number, number], ...rightEdge, ...leftEdge.slice(0, -1)];
  return `polygon(${points.map(([x, y]) => `${x}% ${y}%`).join(", ")})`;
}

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
      // Face-locked glow (lib/video/faceLandmarks.ts + camera3D.ts) -- see
      // CutawayDialog.tsx's own picker.
      faceEffect?: FaceEffectId | null;
      // "Pulse with music" (lib/video/audioReactive.ts) -- see
      // CutawayDialog.tsx's own toggle.
      audioReactive?: boolean;
    }
  | {
      kind: "video";
      entryId: string;
      assetId: string;
      // The clip's own EFFECTIVE start -- nativeStartTimeSeconds plus
      // whatever's already cut from its HEAD by a TrimRange (see
      // transformations.ts's applyTrimCutawayHead and FrameStrip's own
      // cutawaySegments memo, which resolves this). Not the same as
      // nativeStartTimeSeconds below.
      startTimeSeconds: number;
      // The clip's own EFFECTIVE duration -- its real (untrimmed) boundary
      // span minus whatever's already cut from either end by a TrimRange
      // (applyTrimCutawayHead/applyTrimCutawayTail). Not the same as
      // nativeDurationSeconds below.
      durationSeconds: number;
      // The clip's real, untrimmed boundary START -- fixed for as long as
      // this clip sits at this point in the sequence (only reordering or
      // deleting a neighbor changes it), unlike startTimeSeconds above. The
      // left-edge resize handle's own min bound: dragging it back out this
      // far removes the head trim entirely.
      nativeStartTimeSeconds: number;
      // The clip's real, untrimmed boundary SPAN -- same fixed-unless-
      // reordered lifetime as nativeStartTimeSeconds above, unlike
      // durationSeconds. The right-edge resize handle's own max bound:
      // dragging it back out this far removes the tail trim entirely.
      nativeDurationSeconds: number;
      colorFilterId: FilterPresetId | null;
      canvasFillMode: CanvasFillMode | null;
      canvasFillColor?: string;
      canvasFillGradientColor?: string;
      // Same AI background removal as the "image" variant above.
      backgroundRemoval?: BackgroundRemovalState | null;
    }
  | {
      kind: "text";
      entryId: string;
      text: string;
      style: TextSlideStyle;
      layout: TextSlideLayout;
      assetId: string;
      canvasFillMode?: "solid" | "gradient" | null;
      canvasFillColor?: string;
      canvasFillGradientColor?: string;
      entranceId: TextSlideTransitionId;
      exitId: TextSlideTransitionId;
      startTimeSeconds: number;
      durationSeconds: number;
    };

function CutawaySegmentButton({
  segment,
  leftPercent,
  widthPercent,
  isDragging,
  resizingEdge,
  onDragPointerDown,
  onResizeStartPointerDown,
  onResizeEndPointerDown,
  onRestoreHead,
  onRestoreTail,
  onEdit,
  onDelete,
  onOpenFilter,
  onOpenCanvasFill,
}: {
  segment: CutawaySegment;
  leftPercent: number;
  widthPercent: number;
  isDragging: boolean;
  // Which edge (if either) THIS segment is being live-resized from, for the
  // handle's own highlight -- never both at once, a single drag only ever
  // touches one edge.
  resizingEdge: "start" | "end" | null;
  onDragPointerDown: (e: React.PointerEvent) => void;
  onResizeStartPointerDown: (e: React.PointerEvent) => void;
  onResizeEndPointerDown: (e: React.PointerEvent) => void;
  // Right-click "Restore trimmed start"/"Restore trimmed end" -- undoes
  // just that one edge's TrimRange without touching the other. Always
  // provided (even for an image/text segment, which never actually calls
  // it) -- this component itself gates whether the menu item ever shows, via
  // its own isHeadTrimmed/isTailTrimmed below.
  onRestoreHead: () => void;
  onRestoreTail: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenFilter: () => void;
  onOpenCanvasFill: () => void;
}) {
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();
  const isImage = segment.kind === "image";
  const isText = segment.kind === "text";
  const filterOption = segment.kind !== "text" && segment.colorFilterId ? getFilterPresetOption(segment.colorFilterId) : null;
  const canvasFillOption = segment.kind !== "text" && segment.canvasFillMode ? getCanvasFillOption(segment.canvasFillMode) : null;
  // A small epsilon, not exact equality -- these are floating-point seconds
  // derived from a pixel-based drag, so "restored all the way back out"
  // rarely lands on the native bound exactly.
  const isHeadTrimmed = segment.kind === "video" && segment.startTimeSeconds > segment.nativeStartTimeSeconds + 0.05;
  const isTailTrimmed =
    segment.kind === "video" &&
    segment.startTimeSeconds + segment.durationSeconds < segment.nativeStartTimeSeconds + segment.nativeDurationSeconds - 0.05;
  const clipPath = buildCutawayClipPath(isHeadTrimmed, isTailTrimmed);

  return (
    <>
      <button
        type="button"
        onPointerDown={onDragPointerDown}
        onClick={
          isImage || isText
            ? (e) => {
                e.stopPropagation();
                onEdit();
              }
            : undefined
        }
        onContextMenu={(e) =>
          openContextMenu(
            e,
            isText
              ? [{ label: "Remove Text Slide", danger: true, onSelect: onDelete }]
              : [
                  { label: "Filter…", onSelect: onOpenFilter },
                  { label: "Canvas fill…", onSelect: onOpenCanvasFill },
                  ...(isHeadTrimmed ? [{ label: "Restore trimmed start", onSelect: onRestoreHead }] : []),
                  ...(isTailTrimmed ? [{ label: "Restore trimmed end", onSelect: onRestoreTail }] : []),
                  { label: "Remove Cutaway", danger: true, onSelect: onDelete },
                ]
          )
        }
        title={
          segment.kind === "image"
            ? `Drag to reorder -- ${segment.templateIds.length > 0 ? segment.templateIds.map((id) => getImageTemplateOption(id).name).join(" + ") : "Still photo"}; click to edit, right-click for more`
            : segment.kind === "text"
              ? `Drag to reorder this text slide -- "${segment.text}"; click to edit, right-click to remove`
              : "Drag to reorder this video cutaway -- right-click for more"
        }
        className={
          "absolute top-0 flex h-full items-center gap-1 overflow-hidden rounded-sm border text-[9px] leading-none cursor-grab active:cursor-grabbing " +
          (isDragging ? "z-10 opacity-80 ring-2 ring-accent " : "transition-[left] duration-150 ") +
          (isImage
            ? "border-accent bg-accent/30 text-accent hover:bg-accent/50"
            : isText
              ? "border-sky-400 bg-sky-400/30 text-sky-200 hover:bg-sky-400/50"
              : "border-neutral-500/70 bg-neutral-500/20 text-neutral-300 hover:bg-neutral-500/30")
        }
        style={{
          left: `${leftPercent}%`,
          width: `${widthPercent}%`,
          touchAction: "none",
          clipPath,
        }}
      >
        <span className="pointer-events-none shrink-0 pl-1">{isImage ? "🖼" : isText ? "📝" : "▶"}</span>
        <span className="pointer-events-none truncate pr-1">{isText ? segment.text || "Text Slide" : "Cutaway"}</span>
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
        {segment.kind !== "text" && segment.backgroundRemoval?.enabled && (
          // Chroma key has no job to wait on -- matteAssetId stays
          // permanently null (see chromaKey.ts's own module comment), so
          // without this guard the progress badge would show forever on a
          // cutaway that's already fully, correctly keyed. Same guard
          // VideoOverlayTrack.tsx uses for its own equivalent badge.
          segment.backgroundRemoval.mode === "chromaKey" || segment.backgroundRemoval.matteAssetId ? (
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
        {/* Trim-from-the-start resize handle -- same shape as the end
            handle below, mirrored onto the left edge. VIDEO only: a video
            clip's footage genuinely continues past its own trimmed-off
            head, worth revealing again -- an image/text clip's authored
            duration has nothing analogous "before" its own start to skip
            into, so it gets no left handle at all (shrinking one is always
            just the end handle, whichever end that visually reads as). */}
        {segment.kind === "video" && (
          <div
            onPointerDown={(e) => {
              e.stopPropagation();
              onResizeStartPointerDown(e);
            }}
            onClick={(e) => e.stopPropagation()}
            title="Drag to trim this cutaway's start"
            className="absolute left-0 top-0 z-20 h-full w-2 cursor-ew-resize"
            style={{ touchAction: "none" }}
          >
            <div
              className={"absolute left-0 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full " + (resizingEdge === "start" ? "bg-white" : "bg-white/60")}
            />
          </div>
        )}
        {/* Trim-from-the-end resize handle -- a narrow hit region riding
            the segment's own right edge, deliberately stopping propagation
            on both pointerdown and click so it never also starts the
            button's own reorder-drag or (for an image/text segment) opens
            the edit dialog. See CutawayTrack's own handleResizePointerDown
            for what a drag here actually commits, per kind. */}
        <div
          onPointerDown={(e) => {
            e.stopPropagation();
            onResizeEndPointerDown(e);
          }}
          onClick={(e) => e.stopPropagation()}
          title="Drag to trim this cutaway's end"
          className="absolute right-0 top-0 z-20 h-full w-2 cursor-ew-resize"
          style={{ touchAction: "none" }}
        >
          <div
            className={"absolute right-0 top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full " + (resizingEdge === "end" ? "bg-white" : "bg-white/60")}
          />
        </div>
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
  onDropNewTextSlide,
  onResizeStart,
  onResizeEnd,
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
  // Fires once on dropping a NEW Text Slide dragged in from outside this
  // rail (see NEW_CUTAWAY_DRAG_TYPE) -- `atIndex` is in [0, segments.length]
  // inclusive (see insertIndexForClientX below), letting the caller insert
  // the new entry at that exact position -- including after every existing
  // segment -- instead of always appending to the end. Never fires for an
  // ordinary internal reorder drag (that stays on onReorder above).
  onDropNewTextSlide: (segments: CutawaySegment[], atIndex: number) => void;
  // Fires once on drop of the left-edge (trim-from-start) resize handle --
  // never live during the drag, same "only the final release commits" shape
  // as onReorder above and FrameStrip's own older boundary-drag handle --
  // with the ORIGINAL segment (kind/startTimeSeconds/durationSeconds/native*
  // all in one place, no separate lookup) and the new candidate
  // durationSeconds AFTER trimming from the start (i.e. the segment's own
  // effective END stays fixed, its effective START moves to
  // end - newDurationSeconds). Only ever called for a video segment -- see
  // CutawaySegmentButton's own left-handle render guard.
  onResizeStart: (segment: CutawaySegment, newDurationSeconds: number) => void;
  // Same shape as onResizeStart, for the right-edge (trim-from-end) handle:
  // the segment's own effective START stays fixed, its effective END moves
  // to start + newDurationSeconds. Called for every kind -- the caller
  // picks the right transformation by kind (image/text reflow vs. a video's
  // own TrimRange) -- see ThreePaneEditor.tsx's handleResizeCutawayEnd.
  onResizeEnd: (segment: CutawaySegment, newDurationSeconds: number) => void;
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
  // Live preview of the segment currently being resized -- kept local
  // (never lifted to the caller until pointerup) for the same reason
  // dragPreviewOrder above is: committing on every pointermove would re-run
  // ThreePaneEditor's full reflow at 60fps of drag deltas. `edge` says which
  // handle started this drag -- a "start" drag keeps the segment's own
  // effective END fixed (so its LEFT offset must shift live too, not just
  // its width), while an "end" drag keeps its effective START fixed (only
  // width changes) -- see the render map's own leftPercent/widthPercent
  // below.
  const [resizePreview, setResizePreview] = useState<{
    entryId: string;
    edge: "start" | "end";
    candidateDurationSeconds: number;
  } | null>(null);

  // Live insertion point while a NEW Text Slide is being dragged in from
  // outside this rail (see handleTrackDragOver/handleTrackDrop below) --
  // null whenever no such external drag is over the track. Separate from
  // dragPreviewOrder/draggingEntryId above, which are only ever set by an
  // INTERNAL reorder drag (handleDragPointerDown).
  const [externalDropIndex, setExternalDropIndex] = useState<number | null>(null);

  if (segments.length === 0) return null;

  const toPercent = (seconds: number) => (videoDurationSeconds > 0 ? (seconds / videoDurationSeconds) * 100 : 0);

  // The internal reorder drag's own hover-slot logic below -- walks
  // `segments` (the stable, un-previewed order) by x position to find which
  // EXISTING segment's own midpoint the pointer has crossed. Always in
  // range [0, segments.length - 1]; that's correct for a MOVE (the dragged
  // entry is spliced out of the array before being reinserted, so its own
  // former slot never counts against the target range -- reinserting at
  // segments.length - 1 into the now-shorter array already lands at the
  // true end). See insertIndexForClientX below for why a brand-new entry
  // needs a different range.
  function hoverIndexForClientX(clientX: number): number {
    const trackRect = trackRef.current?.getBoundingClientRect();
    if (!trackRect || trackRect.width <= 0 || videoDurationSeconds <= 0) return segments.length - 1;
    const percent = ((clientX - trackRect.left) / trackRect.width) * 100;
    const timeSeconds = (percent / 100) * videoDurationSeconds;
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
    return hoverIndex;
  }

  // Same x-position walk as hoverIndexForClientX, but for dropping a BRAND
  // NEW entry (nothing spliced out first) -- range is [0, segments.length]
  // inclusive, where segments.length itself means "insert after every
  // existing segment," a slot hoverIndexForClientX's own range can't
  // express (its max, segments.length - 1, means "insert before the last
  // segment" here, not after it -- there's no removed slot to absorb that
  // last step). Falls through to that trailing sentinel whenever the drop
  // is past the last segment's own midpoint.
  function insertIndexForClientX(clientX: number): number {
    const trackRect = trackRef.current?.getBoundingClientRect();
    if (!trackRect || trackRect.width <= 0 || videoDurationSeconds <= 0) return segments.length;
    const percent = ((clientX - trackRect.left) / trackRect.width) * 100;
    const timeSeconds = (percent / 100) * videoDurationSeconds;
    let accSeconds = 0;
    for (let i = 0; i < segments.length; i++) {
      const durationSeconds = segments[i].durationSeconds;
      if (timeSeconds < accSeconds + durationSeconds / 2) return i;
      accSeconds += durationSeconds;
    }
    return segments.length;
  }

  function handleTrackDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(NEW_CUTAWAY_DRAG_TYPE)) return;
    e.preventDefault(); // required for onDrop to ever fire
    e.dataTransfer.dropEffect = "copy";
    setExternalDropIndex(insertIndexForClientX(e.clientX));
  }

  function handleTrackDragLeave(e: React.DragEvent) {
    // Only clear once the pointer actually leaves the track (not just moving
    // between two child segment buttons within it, which also fires
    // dragleave on the child) -- relatedTarget is null when it's left the
    // browser window entirely, which should also clear.
    if (e.relatedTarget && trackRef.current?.contains(e.relatedTarget as Node)) return;
    setExternalDropIndex(null);
  }

  function handleTrackDrop(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(NEW_CUTAWAY_DRAG_TYPE)) return;
    e.preventDefault();
    const atIndex = insertIndexForClientX(e.clientX);
    setExternalDropIndex(null);
    onDropNewTextSlide(segments, atIndex);
  }

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
    e.preventDefault(); // no native text-selection/drag-ghost while pressing on the label text inside
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
      // Hover slot: walks the ORIGINAL (not preview) segment order/durations
      // -- a stable reference frame recomputed fresh from `segments` on
      // every move, so a fast drag across several slots never accumulates
      // drift off a stale preview order.
      const hoverIndex = hoverIndexForClientX(ev.clientX);

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

  // Trim-from-the-start/end resize -- drag either edge handle to shrink
  // (or, up to its own max, re-grow) the segment's own displayed duration.
  // An "end" drag anchors the segment's effective START (never moves),
  // so shrinking removes time from the end; a "start" drag anchors its
  // effective END instead, so shrinking removes time from the start --
  // hence the sign flip on deltaSeconds below (dragging the LEFT handle
  // rightward shrinks, same on-screen direction as dragging the RIGHT
  // handle leftward would). The min/max bound differs by kind -- an
  // image/text clip's authored duration clamps between MIN/
  // MAX_IMAGE_CLIP_DURATION_SECONDS (same floor/ceiling CutawayDialog's own
  // duration control already uses), while a video clip's only ever-real
  // bound is its own nativeDurationSeconds (dragging back out that far
  // removes that edge's trim entirely -- see applyTrimCutawayHead/
  // applyTrimCutawayTail).
  function handleResizePointerDown(e: React.PointerEvent, segment: CutawaySegment, edge: "start" | "end") {
    if (e.button !== 0) return;
    e.preventDefault();
    const startClientX = e.clientX;
    const startDurationSeconds = segment.durationSeconds;
    const minDurationSeconds = segment.kind === "video" ? MIN_VIDEO_CUTAWAY_DURATION_SECONDS : MIN_IMAGE_CLIP_DURATION_SECONDS;
    const maxDurationSeconds = segment.kind === "video" ? segment.nativeDurationSeconds : MAX_IMAGE_CLIP_DURATION_SECONDS;
    let candidateDurationSeconds = startDurationSeconds;
    setResizePreview({ entryId: segment.entryId, edge, candidateDurationSeconds });

    function handleMove(ev: PointerEvent) {
      const trackRect = trackRef.current?.getBoundingClientRect();
      if (!trackRect || trackRect.width <= 0 || videoDurationSeconds <= 0) return;
      const rawDeltaSeconds = ((ev.clientX - startClientX) / trackRect.width) * videoDurationSeconds;
      const deltaSeconds = edge === "end" ? rawDeltaSeconds : -rawDeltaSeconds;
      candidateDurationSeconds = Math.min(maxDurationSeconds, Math.max(minDurationSeconds, startDurationSeconds + deltaSeconds));
      setResizePreview({ entryId: segment.entryId, edge, candidateDurationSeconds });
    }

    function handleUp() {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      setResizePreview(null);
      // A small dead zone, same reasoning as DRAG_THRESHOLD_PX above -- a
      // press-release with barely any movement shouldn't push a no-op
      // history entry.
      if (Math.abs(candidateDurationSeconds - startDurationSeconds) > 0.05) {
        if (edge === "end") onResizeEnd(segment, candidateDurationSeconds);
        else onResizeStart(segment, candidateDurationSeconds);
      }
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  // Right-click "Restore trimmed start/end" -- undoes just ONE edge's trim,
  // computed so the OTHER edge's own current position (which may itself
  // already be trimmed) is preserved rather than reset. onResizeStart/
  // onResizeEnd always anchor at the segment's own OTHER effective edge
  // (see their own prop comments), so handing them "the full distance back
  // to nativeStart/nativeEnd from that anchor" is exactly a restore of just
  // this one edge, whatever the other edge currently is.
  function handleRestoreHead(segment: CutawaySegment) {
    if (segment.kind !== "video") return;
    onResizeStart(segment, segment.startTimeSeconds + segment.durationSeconds - segment.nativeStartTimeSeconds);
  }
  function handleRestoreTail(segment: CutawaySegment) {
    if (segment.kind !== "video") return;
    onResizeEnd(segment, segment.nativeStartTimeSeconds + segment.nativeDurationSeconds - segment.startTimeSeconds);
  }

  // Where the insertion-point indicator line sits while a new Text Slide is
  // being dragged in -- the running sum of durations of every segment
  // BEFORE externalDropIndex, in `segments`' own (un-previewed) order, since
  // an external drag and an internal reorder drag never overlap.
  const externalDropLeftPercent =
    externalDropIndex !== null
      ? toPercent(segments.slice(0, externalDropIndex).reduce((sum, s) => sum + s.durationSeconds, 0))
      : null;

  return (
    <div
      ref={trackRef}
      className="relative mb-1 h-4 w-full shrink-0"
      onDragOver={handleTrackDragOver}
      onDragLeave={handleTrackDragLeave}
      onDrop={handleTrackDrop}
    >
      {externalDropLeftPercent !== null && (
        <div
          className="pointer-events-none absolute top-0 z-30 h-full w-0.5 -translate-x-1/2 bg-sky-300"
          style={{ left: `${externalDropLeftPercent}%` }}
        />
      )}
      {segments.map((segment) => {
        const isResizingThis = resizePreview?.entryId === segment.entryId;
        const previewDurationSeconds = isResizingThis ? resizePreview.candidateDurationSeconds : segment.durationSeconds;
        // A "start"-edge drag moves the segment's own LEFT offset live too
        // (its effective end is the fixed anchor) -- computed from the
        // segment's OWN current end, not from leftPercentByEntryId (which
        // only tracks reorder preview, never a resize in progress).
        const previewStartTimeSeconds =
          isResizingThis && resizePreview.edge === "start"
            ? segment.startTimeSeconds + segment.durationSeconds - resizePreview.candidateDurationSeconds
            : segment.startTimeSeconds;
        return (
          <CutawaySegmentButton
            key={segment.entryId}
            segment={segment}
            leftPercent={
              isResizingThis && resizePreview.edge === "start"
                ? toPercent(previewStartTimeSeconds)
                : (leftPercentByEntryId.get(segment.entryId) ?? toPercent(segment.startTimeSeconds))
            }
            widthPercent={toPercent(previewDurationSeconds)}
            isDragging={draggingEntryId === segment.entryId}
            resizingEdge={isResizingThis ? resizePreview.edge : null}
            onDragPointerDown={(e) => handleDragPointerDown(e, segment.entryId)}
            onResizeStartPointerDown={(e) => handleResizePointerDown(e, segment, "start")}
            onResizeEndPointerDown={(e) => handleResizePointerDown(e, segment, "end")}
            onRestoreHead={() => handleRestoreHead(segment)}
            onRestoreTail={() => handleRestoreTail(segment)}
            onEdit={() => {
              if (didDragRef.current) return;
              onEdit(segment);
            }}
            onDelete={() => onDelete(segment)}
            onOpenFilter={() => onOpenFilter(segment)}
            onOpenCanvasFill={() => onOpenCanvasFill(segment)}
          />
        );
      })}
    </div>
  );
}
