"use client";

/**
 * Renders the video sequence "unfolded" into one thumbnail per second, and
 * doubles as a scrub timeline: click anywhere on the strip to seek
 * CanvasPlayer to that time, and a vertical playhead tracks playback
 * position as it advances (see ThreePaneEditor's currentTimeSeconds/onSeek
 * wiring, and CanvasPlayer's seekTo/onTimeUpdate).
 *
 * Each tile is a fixed `pixelsPerSecond` wide -- so this strip's total
 * width is exactly `thumbnails.length * pixelsPerSecond`, the same scale
 * Playground.tsx uses for VolumeGraph and BackgroundTrackStrip, so all
 * three line up and can share one scroll position (see
 * lib/useSyncedHorizontalScroll.ts) -- but its HEIGHT comes from
 * `frameAspectRatio` (width / height), not from the row's own available
 * height: sizing the box itself to the video's real shape means the image
 * fills it exactly, with no letterboxing, which in turn means
 * CropRectOverlay's percentage positioning (relative to this same box)
 * lines up with the image with no separate correction needed.
 *
 * IMPORTANT: each tile's own timestamp comes from `thumbnailTimestampsSeconds`
 * (built by ThreePaneEditor in lockstep with `thumbnails`), NOT derived
 * from `(index / (thumbnails.length - 1)) * durationSeconds`. That
 * derivation only holds when thumbnails are evenly spaced across the
 * WHOLE duration, which was true for a single clip but breaks once the
 * sequence concatenates several clips' independently-generated thumbnail
 * arrays (each contributing its own extra fractional final-sample
 * thumbnail) -- an even-spacing assumption would drift tile timestamps
 * away from what's actually showing, more so the more clips there are.
 * `clipBoundarySeconds` draws a thin divider at each clip seam so they're
 * visible instead of invisible.
 *
 * Each thumbnail also shows the crop rectangle that would apply at that
 * moment (baseCropRect, or the zoom-interpolated rect from whichever
 * ZoomEffect covers that timestamp -- see lib/video/video_math.ts's
 * computeEffectiveCropRect). Only the ACTIVE tile -- the one whose own
 * timestamp is closest to the current playhead, i.e. the same instant
 * CanvasPlayer is showing -- gets a draggable/resizable overlay (plus
 * flip/mirror edge handles); every other tile stays read-only. This keeps
 * "editing the crop here" meaning exactly one thing regardless of whether
 * you drag on the live preview or on the timeline: both edit the crop at
 * the current time (see ThreePaneEditor's handleCropRectCommit for what
 * that turns into -- either the flat base crop, or one end of a
 * transition that spreads to neighboring frames). Flip/mirror, unlike
 * crop, applies uniformly to the whole clip -- every thumbnail mirrors via
 * a CSS transform, not just the active tile.
 *
 * Each tile's crop rect and flip state only depend on
 * baseCropRect/zoomEffects/flip toggle lists (its own fixed timestamp never
 * changes), NOT on currentTimeSeconds -- FrameTile is memoized so the
 * ~60/sec playhead updates during playback don't re-render every
 * thumbnail, only the active one (as it hands off between tiles) and the
 * separate playhead line element.
 *
 * ZoomEffectsTrack (every transition's own indicator), FlipTrack (one per
 * flip axis, when either has any toggles), OverlayTrack (one row per image
 * overlay), and TextOverlayTrack (one row per caption) render BELOW the
 * thumbnails; TrimTrack (the click-to-cut gray/red line) renders ABOVE
 * them instead, per its own spec. All of them live in the SAME scrollable
 * track as the thumbnails, so everything shares one scroll position and
 * one pixel-accurate timeline width with no manual measurement needed.
 * Tiles inside a trimmed range are dimmed (see FrameTile's isTrimmed) --
 * the cut is real (CanvasPlayer's skipTrimmedRanges actually skips it
 * during playback), this is just showing where.
 *
 * Each tile also shows every image/text overlay active at its own instant
 * (see video_math.ts's findActiveOverlays/findActiveTextOverlays) as its
 * own OverlayRectOverlay/TextOverlayCanvas, on TOP of the crop rectangle --
 * an overlay sits over the clip, not instead of it. Only the active
 * tile's overlays are draggable/resizable, same gating as the crop
 * rectangle.
 */
import { memo, useMemo, useRef, useState } from "react";
import { CropRectOverlay } from "./CropRectOverlay";
import { OverlayRectOverlay } from "./OverlayRectOverlay";
import { TextOverlayCanvas } from "./TextOverlayCanvas";
import { ZoomEffectsTrack } from "./ZoomEffectsTrack";
import { FlipTrack } from "./FlipTrack";
import { TrimTrack } from "./TrimTrack";
import { OverlayTrack } from "./OverlayTrack";
import { TextOverlayTrack } from "./TextOverlayTrack";
import {
  computeEffectiveCropRect,
  computeEffectiveFlip,
  computeFlipSegments,
  computeProgress,
  findClosestTimestampIndex,
  findTrimRangeIndexAt,
  type CropRect,
  type OverlayImage,
  type SequenceEntry,
  type TextOverlay,
  type TrimRange,
  type ZoomEffect,
} from "@/lib/video/video_math";

const FrameTile = memo(function FrameTile({
  src,
  index,
  widthPx,
  frameAspectRatio,
  cropRect,
  flipHorizontal,
  flipVertical,
  isTrimmed,
  overlays,
  assetUrlById,
  textOverlays,
  onChange,
  onCommit,
  onFlipHorizontal,
  onFlipVertical,
  onOverlayRectChange,
  onOverlayRectCommit,
  onTextOverlayRectChange,
  onTextOverlayRectCommit,
}: {
  src: string;
  index: number;
  widthPx: number;
  frameAspectRatio: number | null;
  cropRect: CropRect | null;
  flipHorizontal: boolean;
  flipVertical: boolean;
  isTrimmed: boolean;
  overlays: { overlay: OverlayImage; overlayIndex: number }[];
  assetUrlById: Record<string, string>;
  textOverlays: { overlay: TextOverlay; overlayIndex: number; progress: number }[];
  onChange?: (next: CropRect) => void;
  onCommit?: (next: CropRect) => void;
  onFlipHorizontal?: () => void;
  onFlipVertical?: () => void;
  onOverlayRectChange?: (overlayIndex: number, next: CropRect) => void;
  onOverlayRectCommit?: (overlayIndex: number, next: CropRect) => void;
  onTextOverlayRectChange?: (overlayIndex: number, next: CropRect) => void;
  onTextOverlayRectCommit?: (overlayIndex: number, next: CropRect) => void;
}) {
  const scaleX = flipHorizontal ? -1 : 1;
  const scaleY = flipVertical ? -1 : 1;
  return (
    // overflow-hidden is load-bearing: CropRectOverlay dims outside its rect
    // via a 9999px box-shadow, which is only ever clipped by an ancestor's
    // overflow -- without this, every tile's shadow bleeds across all its
    // neighbors, and with ~100+ tiles stacking that effect the whole strip
    // reads as going dark ("frames disappearing" while scrolling further
    // into it, since more tiles compounding the bleed come into view).
    //
    // Natural height from width + aspect-ratio, not capped to fit some
    // container height -- if that makes the row taller than the
    // Playground's allocated space, Playground.tsx scrolls vertically
    // rather than this shrinking (or centering with padding) to fit.
    <div
      className={`relative shrink-0 overflow-hidden ${isTrimmed ? "opacity-30" : ""}`}
      style={{ width: widthPx, aspectRatio: frameAspectRatio ?? undefined }}
    >
      {/* Safe to fill the box exactly (object-cover would normally risk
          cropping) -- the box's own aspect-ratio already matches the
          image's, so there is nothing to crop. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- short-lived data URLs, not a Next-optimizable remote image */}
      <img
        src={src}
        alt={`Frame at ${index}s`}
        className="h-full w-full object-cover"
        style={scaleX !== 1 || scaleY !== 1 ? { transform: `scale(${scaleX}, ${scaleY})` } : undefined}
      />
      {cropRect && (
        <CropRectOverlay
          cropRect={cropRect}
          onChange={onChange}
          onCommit={onCommit}
          onFlipHorizontal={onFlipHorizontal}
          onFlipVertical={onFlipVertical}
        />
      )}
      {overlays.map(({ overlay, overlayIndex }) => (
        <OverlayRectOverlay
          key={overlayIndex}
          rect={overlay.rect}
          imageUrl={assetUrlById[overlay.assetId] ?? ""}
          onChange={onOverlayRectChange ? (next) => onOverlayRectChange(overlayIndex, next) : undefined}
          onCommit={onOverlayRectCommit ? (next) => onOverlayRectCommit(overlayIndex, next) : undefined}
        />
      ))}
      {textOverlays.map(({ overlay, overlayIndex, progress }) => (
        <OverlayRectOverlay
          key={overlayIndex}
          rect={overlay.rect}
          onChange={onTextOverlayRectChange ? (next) => onTextOverlayRectChange(overlayIndex, next) : undefined}
          onCommit={onTextOverlayRectCommit ? (next) => onTextOverlayRectCommit(overlayIndex, next) : undefined}
          renderInner={
            <TextOverlayCanvas text={overlay.text} templateId={overlay.templateId} progress={progress} className="h-full w-full" />
          }
        />
      ))}
    </div>
  );
});

export function FrameStrip({
  thumbnails,
  thumbnailTimestampsSeconds,
  clipBoundarySeconds,
  sequenceEntries,
  onResizeImageClip,
  isLoading,
  durationSeconds,
  currentTimeSeconds,
  onSeek,
  baseCropRect,
  zoomEffects,
  frameAspectRatio,
  onChangeZoomRange,
  onCommitZoomRange,
  onChangeZoomEpicenter,
  onCommitZoomEpicenter,
  onDeleteZoomEffect,
  onCropRectChange,
  onCropRectCommit,
  flipHorizontalToggles,
  flipVerticalToggles,
  onFlipHorizontal,
  onFlipVertical,
  trimRanges,
  pendingTrimStartSeconds,
  onTrimTrackClick,
  onMoveTrimDot,
  onDeleteTrimRange,
  overlayImages,
  assetUrlById,
  onChangeOverlayRect,
  onCommitOverlayRect,
  onChangeOverlayRange,
  onCommitOverlayRange,
  onDeleteOverlay,
  textOverlays,
  onChangeTextOverlayRect,
  onCommitTextOverlayRect,
  onChangeTextOverlayRange,
  onCommitTextOverlayRange,
  onDeleteTextOverlay,
  onRequestEditTextOverlay,
  pixelsPerSecond,
  scrollContainerRef,
  onScroll,
}: {
  thumbnails: string[];
  thumbnailTimestampsSeconds: number[];
  clipBoundarySeconds: number[];
  // In-order clip metadata, aligned with the groupings clipBoundarySeconds
  // divides -- sequenceEntries[i] is the clip that ENDS at
  // clipBoundarySeconds[i]. Only an "image" entry's boundary becomes a
  // drag handle (see handleBoundaryPointerDown below); a video seam stays
  // the plain read-only divider it always was.
  sequenceEntries: SequenceEntry[];
  onResizeImageClip: (entryId: string, newDurationSeconds: number, clipStartSeconds: number) => void;
  isLoading: boolean;
  durationSeconds: number;
  currentTimeSeconds: number;
  onSeek: (seconds: number) => void;
  baseCropRect: CropRect | null;
  zoomEffects: ZoomEffect[];
  frameAspectRatio: number | null;
  onChangeZoomRange: (effectIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitZoomRange: (effectIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onChangeZoomEpicenter: (effectIndex: number, epicenterTimeSeconds: number) => void;
  onCommitZoomEpicenter: (effectIndex: number, epicenterTimeSeconds: number) => void;
  onDeleteZoomEffect: (effectIndex: number) => void;
  onCropRectChange: (next: CropRect) => void;
  onCropRectCommit: (next: CropRect) => void;
  flipHorizontalToggles: number[];
  flipVerticalToggles: number[];
  onFlipHorizontal: () => void;
  onFlipVertical: () => void;
  trimRanges: TrimRange[];
  pendingTrimStartSeconds: number | null;
  onTrimTrackClick: (timeSeconds: number) => void;
  onMoveTrimDot: (timeSeconds: number) => void;
  onDeleteTrimRange: (rangeIndex: number) => void;
  overlayImages: OverlayImage[];
  assetUrlById: Record<string, string>;
  onChangeOverlayRect: (overlayIndex: number, next: CropRect) => void;
  onCommitOverlayRect: (overlayIndex: number, next: CropRect) => void;
  onChangeOverlayRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitOverlayRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onDeleteOverlay: (overlayIndex: number) => void;
  textOverlays: TextOverlay[];
  onChangeTextOverlayRect: (overlayIndex: number, next: CropRect) => void;
  onCommitTextOverlayRect: (overlayIndex: number, next: CropRect) => void;
  onChangeTextOverlayRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitTextOverlayRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onDeleteTextOverlay: (overlayIndex: number) => void;
  onRequestEditTextOverlay: (overlayIndex: number) => void;
  pixelsPerSecond: number;
  scrollContainerRef: (el: HTMLDivElement | null) => void;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  // Post-add duration drag on an image clip's own boundary marker (the
  // popup that adds the clip sets its INITIAL duration; this is how it
  // stays adjustable afterward, on the main timeline, per the driving
  // vision's "direct manipulation over dialogs" bias). Kept entirely LOCAL
  // to this component while dragging -- only the final release fires
  // onResizeImageClip -- rather than lifting a live value up to
  // ThreePaneEditor on every pointermove, since committing there re-runs
  // the whole thumbnail/duration extraction effect (expensive to do at
  // 60fps of drag deltas).
  const [draggingBoundary, setDraggingBoundary] = useState<{
    index: number;
    clipStartSeconds: number;
    candidateSeconds: number;
  } | null>(null);

  function handleBoundaryPointerDown(
    index: number,
    clipStartSeconds: number,
    boundarySeconds: number,
    e: React.PointerEvent<HTMLDivElement>
  ) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraggingBoundary({ index, clipStartSeconds, candidateSeconds: boundarySeconds });
  }
  function handleBoundaryPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!draggingBoundary || !trackRef.current || durationSeconds <= 0) return;
    const rect = trackRef.current.getBoundingClientRect();
    const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    setDraggingBoundary({ ...draggingBoundary, candidateSeconds: fraction * durationSeconds });
  }
  function handleBoundaryPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.releasePointerCapture(e.pointerId);
    if (!draggingBoundary) return;
    const entry = sequenceEntries[draggingBoundary.index];
    if (entry?.kind === "image") {
      const newDurationSeconds = draggingBoundary.candidateSeconds - draggingBoundary.clipStartSeconds;
      onResizeImageClip(entry.id, newDurationSeconds, draggingBoundary.clipStartSeconds);
    }
    setDraggingBoundary(null);
  }

  // Recomputed only when the crop/zoom actually changes -- NOT on every
  // currentTimeSeconds tick during playback (see FrameTile's memo comment).
  const tileCropRects = useMemo(() => {
    if (!baseCropRect) return thumbnails.map(() => null);
    return thumbnailTimestampsSeconds.map((timestamp) => computeEffectiveCropRect(baseCropRect, zoomEffects, timestamp));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, baseCropRect, zoomEffects]);

  const tileFlips = useMemo(() => {
    return thumbnailTimestampsSeconds.map((timestamp) => ({
      flipHorizontal: computeEffectiveFlip(flipHorizontalToggles, timestamp),
      flipVertical: computeEffectiveFlip(flipVerticalToggles, timestamp),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, flipHorizontalToggles, flipVerticalToggles]);

  const flipHorizontalSegments = useMemo(
    () => computeFlipSegments(flipHorizontalToggles, durationSeconds),
    [flipHorizontalToggles, durationSeconds]
  );
  const flipVerticalSegments = useMemo(
    () => computeFlipSegments(flipVerticalToggles, durationSeconds),
    [flipVerticalToggles, durationSeconds]
  );

  const tileIsTrimmed = useMemo(() => {
    return thumbnailTimestampsSeconds.map((timestamp) => findTrimRangeIndexAt(trimRanges, timestamp) !== -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, trimRanges]);

  // Keeps each overlay's original index into overlayImages (needed to
  // dispatch onChangeOverlayRect/onCommitOverlayRect against the right
  // entry) -- a plain .filter() on its own would lose that.
  const tileOverlays = useMemo(() => {
    return thumbnailTimestampsSeconds.map((timestamp) =>
      overlayImages
        .map((overlay, overlayIndex) => ({ overlay, overlayIndex }))
        .filter(({ overlay }) => timestamp >= overlay.startTimeSeconds && timestamp < overlay.endTimeSeconds)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, overlayImages]);

  const tileTextOverlays = useMemo(() => {
    return thumbnailTimestampsSeconds.map((timestamp) =>
      textOverlays
        .map((overlay, overlayIndex) => ({
          overlay,
          overlayIndex,
          progress: computeProgress(overlay.startTimeSeconds, overlay.endTimeSeconds, timestamp),
        }))
        .filter(({ overlay }) => timestamp >= overlay.startTimeSeconds && timestamp < overlay.endTimeSeconds)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, thumbnailTimestampsSeconds, textOverlays]);

  // The tile whose OWN timestamp is closest to the playhead -- NOT an
  // even-spacing index formula (see this file's module comment on why
  // that breaks for a concatenated sequence). Still only this one tile's
  // memo identity flips per tick, not all of them.
  const activeTileIndex = useMemo(
    () => findClosestTimestampIndex(thumbnailTimestampsSeconds, currentTimeSeconds),
    [thumbnailTimestampsSeconds, currentTimeSeconds]
  );

  if (thumbnails.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 px-2 text-xs text-muted">
        {isLoading ? "Generating thumbnails…" : "Add a video to see its timeline"}
      </div>
    );
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (durationSeconds <= 0 || !trackRef.current) return;
    // getBoundingClientRect() reflects the track's current rendered
    // position, scroll offset included -- clientX (a viewport coordinate)
    // minus rect.left is correct however far the strip has been scrolled.
    const rect = trackRef.current.getBoundingClientRect();
    const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    onSeek(fraction * durationSeconds);
  }

  const playheadPercent =
    durationSeconds > 0 ? Math.min(Math.max(currentTimeSeconds / durationSeconds, 0), 1) * 100 : 0;

  return (
    <div
      ref={scrollContainerRef}
      onScroll={onScroll}
      className="hide-scrollbar max-h-full overflow-x-auto bg-neutral-950 px-2"
    >
      {/* w-max so this div's own width is the strip's true total length --
          the playhead and ZoomEffectsTrack below both size/position
          relative to THIS box, so they stay aligned with the right
          thumbnail (and each other) at any scroll position. Height is
          natural (tile height + the effects track), NOT stretched to fill
          whatever space Playground.tsx allocates -- see FrameTile's
          comment for why forcing that produced unwanted blank padding. */}
      <div ref={trackRef} className="relative flex w-max flex-col">
        <TrimTrack
          trimRanges={trimRanges}
          pendingTrimStartSeconds={pendingTrimStartSeconds}
          videoDurationSeconds={durationSeconds}
          onClick={onTrimTrackClick}
          onMoveDot={onMoveTrimDot}
          onDeleteRange={onDeleteTrimRange}
        />

        <div onClick={handleClick} className="flex cursor-pointer items-center">
          {thumbnails.map((src, index) => (
            <FrameTile
              key={index}
              src={src}
              index={index}
              widthPx={pixelsPerSecond}
              frameAspectRatio={frameAspectRatio}
              cropRect={tileCropRects[index]}
              flipHorizontal={tileFlips[index].flipHorizontal}
              flipVertical={tileFlips[index].flipVertical}
              isTrimmed={tileIsTrimmed[index]}
              overlays={tileOverlays[index]}
              assetUrlById={assetUrlById}
              textOverlays={tileTextOverlays[index]}
              onChange={index === activeTileIndex ? onCropRectChange : undefined}
              onCommit={index === activeTileIndex ? onCropRectCommit : undefined}
              onFlipHorizontal={index === activeTileIndex ? onFlipHorizontal : undefined}
              onFlipVertical={index === activeTileIndex ? onFlipVertical : undefined}
              onOverlayRectChange={index === activeTileIndex ? onChangeOverlayRect : undefined}
              onOverlayRectCommit={index === activeTileIndex ? onCommitOverlayRect : undefined}
              onTextOverlayRectChange={index === activeTileIndex ? onChangeTextOverlayRect : undefined}
              onTextOverlayRectCommit={index === activeTileIndex ? onCommitTextOverlayRect : undefined}
            />
          ))}
        </div>

        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-red-500"
          style={{ left: `${playheadPercent}%` }}
        />

        {clipBoundarySeconds.map((boundarySeconds, index) => {
          const clipStartSeconds = index === 0 ? 0 : clipBoundarySeconds[index - 1];
          const isImageBoundary = sequenceEntries[index]?.kind === "image";
          const isDraggingThis = draggingBoundary?.index === index;
          const positionSeconds = isDraggingThis ? draggingBoundary.candidateSeconds : boundarySeconds;
          const leftPercent = durationSeconds > 0 ? (positionSeconds / durationSeconds) * 100 : 0;

          if (!isImageBoundary) {
            return (
              <div
                key={index}
                title="Clip boundary"
                className="pointer-events-none absolute inset-y-0 w-px bg-white/60"
                style={{ left: `${leftPercent}%` }}
              />
            );
          }

          return (
            <div
              key={index}
              title="Drag to resize this photo clip's duration"
              onPointerDown={(e) => handleBoundaryPointerDown(index, clipStartSeconds, boundarySeconds, e)}
              onPointerMove={handleBoundaryPointerMove}
              onPointerUp={handleBoundaryPointerUp}
              className="absolute inset-y-0 flex w-3 -translate-x-1/2 cursor-ew-resize items-center justify-center"
              style={{ left: `${leftPercent}%` }}
            >
              <div className={"h-full w-0.5 " + (isDraggingThis ? "bg-accent" : "bg-accent/70")} />
            </div>
          );
        })}

        <ZoomEffectsTrack
          zoomEffects={zoomEffects}
          videoDurationSeconds={durationSeconds}
          onChangeRange={onChangeZoomRange}
          onCommitRange={onCommitZoomRange}
          onChangeEpicenter={onChangeZoomEpicenter}
          onCommitEpicenter={onCommitZoomEpicenter}
          onDeleteEffect={onDeleteZoomEffect}
        />
        <FlipTrack
          segments={flipHorizontalSegments}
          videoDurationSeconds={durationSeconds}
          colorClassName="bg-red-500/50 border border-red-500"
          title="Flipped"
        />
        <FlipTrack
          segments={flipVerticalSegments}
          videoDurationSeconds={durationSeconds}
          colorClassName="bg-purple-500/50 border border-purple-500"
          title="Mirrored"
        />
        <OverlayTrack
          overlayImages={overlayImages}
          assetUrlById={assetUrlById}
          videoDurationSeconds={durationSeconds}
          onChangeRange={onChangeOverlayRange}
          onCommitRange={onCommitOverlayRange}
          onDelete={onDeleteOverlay}
        />
        <TextOverlayTrack
          textOverlays={textOverlays}
          videoDurationSeconds={durationSeconds}
          onChangeRange={onChangeTextOverlayRange}
          onCommitRange={onCommitTextOverlayRange}
          onEdit={onRequestEditTextOverlay}
          onDelete={onDeleteTextOverlay}
        />
      </div>
    </div>
  );
}
