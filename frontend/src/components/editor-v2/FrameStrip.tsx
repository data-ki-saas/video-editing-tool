"use client";

/**
 * Renders the video "unfolded" into one thumbnail per second, and doubles
 * as a scrub timeline: click anywhere on the strip to seek CanvasPlayer to
 * that time, and a vertical playhead tracks playback position as it
 * advances (see ThreePaneEditor's currentTimeSeconds/onSeek wiring, and
 * CanvasPlayer's seekTo/onTimeUpdate).
 *
 * Each thumbnail is a fixed `pixelsPerSecond` wide (not sized to its own
 * aspect ratio) so this strip's total width is exactly
 * `thumbnails.length * pixelsPerSecond` -- the same scale Playground.tsx
 * uses for VolumeGraph and BackgroundTrackStrip, so all three line up and
 * can share one scroll position (see lib/useSyncedHorizontalScroll.ts).
 *
 * Each thumbnail also shows the crop rectangle that would apply at that
 * moment (baseCropRect, or the zoom-interpolated rect if a ZoomEffect
 * covers that timestamp -- see lib/video/video_math.ts's
 * computeEffectiveCropRect). Only the ACTIVE tile -- the one nearest the
 * current playhead, i.e. the same instant CanvasPlayer is showing -- gets
 * a draggable/resizable overlay (plus flip/mirror edge handles); every
 * other tile stays read-only. This keeps "editing the crop here" meaning
 * exactly one thing regardless of whether you drag on the live preview or
 * on the timeline: both edit the crop at the current time (see
 * ThreePaneEditor's handleCropRectCommit for what that turns into --
 * either the flat base crop, or one end of a transition that spreads to
 * neighboring frames). Flip/mirror, unlike crop, applies uniformly to the
 * whole clip -- every thumbnail mirrors via a CSS transform when active,
 * not just the active tile.
 *
 * Each tile's crop rect only depends on baseCropRect/zoomEffect (its own
 * fixed timestamp never changes), NOT on currentTimeSeconds -- FrameTile is
 * memoized so the ~60/sec playhead updates during playback don't re-render
 * every thumbnail, only the active one (as it hands off between tiles) and
 * the separate playhead line element.
 *
 * The zoom/transition effect's own indicator (ZoomEffectRow) renders in
 * the SAME scrollable track as the thumbnails, directly below them, so
 * both share one scroll position and one pixel-accurate timeline width
 * with no manual measurement needed.
 */
import { memo, useMemo, useRef } from "react";
import { CropRectOverlay } from "./CropRectOverlay";
import { ZoomEffectRow } from "./ZoomEffectRow";
import { computeEffectiveCropRect, type CropRect, type ZoomEffect } from "@/lib/video/video_math";

const FrameTile = memo(function FrameTile({
  src,
  index,
  widthPx,
  cropRect,
  flipHorizontal,
  flipVertical,
  onChange,
  onCommit,
  onFlipHorizontal,
  onFlipVertical,
}: {
  src: string;
  index: number;
  widthPx: number;
  cropRect: CropRect | null;
  flipHorizontal: boolean;
  flipVertical: boolean;
  onChange?: (next: CropRect) => void;
  onCommit?: (next: CropRect) => void;
  onFlipHorizontal?: () => void;
  onFlipVertical?: () => void;
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
    <div className="relative h-full shrink-0 overflow-hidden" style={{ width: widthPx }}>
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
    </div>
  );
});

export function FrameStrip({
  thumbnails,
  isLoading,
  durationSeconds,
  currentTimeSeconds,
  onSeek,
  baseCropRect,
  zoomEffect,
  onChangeZoomRange,
  onCommitZoomRange,
  onCropRectChange,
  onCropRectCommit,
  flipHorizontal,
  flipVertical,
  onFlipHorizontal,
  onFlipVertical,
  pixelsPerSecond,
  scrollContainerRef,
  onScroll,
}: {
  thumbnails: string[];
  isLoading: boolean;
  durationSeconds: number;
  currentTimeSeconds: number;
  onSeek: (seconds: number) => void;
  baseCropRect: CropRect | null;
  zoomEffect: ZoomEffect | null;
  onChangeZoomRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitZoomRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
  onCropRectChange: (next: CropRect) => void;
  onCropRectCommit: (next: CropRect) => void;
  flipHorizontal: boolean;
  flipVertical: boolean;
  onFlipHorizontal: () => void;
  onFlipVertical: () => void;
  pixelsPerSecond: number;
  scrollContainerRef: (el: HTMLDivElement | null) => void;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  // Recomputed only when the crop/zoom actually changes -- NOT on every
  // currentTimeSeconds tick during playback (see FrameTile's memo comment).
  const tileCropRects = useMemo(() => {
    if (!baseCropRect) return thumbnails.map(() => null);
    return thumbnails.map((_, index) => {
      const timestamp = thumbnails.length > 1 ? (index / (thumbnails.length - 1)) * durationSeconds : 0;
      return computeEffectiveCropRect(baseCropRect, zoomEffect, timestamp);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- thumbnails.length (not the array reference) is what actually matters here
  }, [thumbnails.length, durationSeconds, baseCropRect, zoomEffect]);

  // The tile nearest the playhead -- this DOES change every tick, but only
  // this one tile's memo identity flips (false->true / true->false) as a
  // result, not all of them, so it doesn't reintroduce the per-tick
  // re-render cost tileCropRects above avoids.
  const activeTileIndex =
    thumbnails.length > 0 && durationSeconds > 0
      ? Math.round((currentTimeSeconds / durationSeconds) * (thumbnails.length - 1))
      : -1;

  if (thumbnails.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 px-2 text-xs text-muted">
        {isLoading ? "Generating thumbnails…" : "Select a video to see its timeline"}
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
    <div ref={scrollContainerRef} onScroll={onScroll} className="h-full overflow-x-auto bg-neutral-950 px-2">
      {/* w-max so this div's own width is the strip's true total length --
          the playhead and ZoomEffectRow below both size/position relative
          to THIS box, so they stay aligned with the right thumbnail (and
          each other) at any scroll position. */}
      <div ref={trackRef} className="relative flex h-full w-max flex-col">
        <div onClick={handleClick} className="flex flex-1 cursor-pointer items-center">
          {thumbnails.map((src, index) => (
            <FrameTile
              key={index}
              src={src}
              index={index}
              widthPx={pixelsPerSecond}
              cropRect={tileCropRects[index]}
              flipHorizontal={flipHorizontal}
              flipVertical={flipVertical}
              onChange={index === activeTileIndex ? onCropRectChange : undefined}
              onCommit={index === activeTileIndex ? onCropRectCommit : undefined}
              onFlipHorizontal={index === activeTileIndex ? onFlipHorizontal : undefined}
              onFlipVertical={index === activeTileIndex ? onFlipVertical : undefined}
            />
          ))}
        </div>

        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-red-500"
          style={{ left: `${playheadPercent}%` }}
        />

        {zoomEffect && (
          <ZoomEffectRow
            zoomEffect={zoomEffect}
            videoDurationSeconds={durationSeconds}
            onChangeRange={onChangeZoomRange}
            onCommitRange={onCommitZoomRange}
          />
        )}
      </div>
    </div>
  );
}
