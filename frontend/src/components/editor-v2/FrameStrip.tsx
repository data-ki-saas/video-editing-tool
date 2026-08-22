"use client";

/**
 * Renders the video "unfolded" into one thumbnail per second, and doubles
 * as a scrub timeline: click anywhere on the strip to seek CanvasPlayer to
 * that time, and a vertical playhead tracks playback position as it
 * advances (see ThreePaneEditor's currentTimeSeconds/onSeek wiring, and
 * CanvasPlayer's seekTo/onTimeUpdate).
 *
 * Each thumbnail also shows the crop rectangle that would apply at that
 * moment (baseCropRect, or the zoom-interpolated rect if a ZoomEffect
 * covers that timestamp -- see lib/video/video_math.ts's
 * computeEffectiveCropRect), read-only here; CropRectOverlay's draggable
 * version lives on CanvasPlayer's live preview instead. Each tile's crop
 * rect only depends on baseCropRect/zoomEffect (its own fixed timestamp
 * never changes), NOT on currentTimeSeconds -- FrameTile is memoized so
 * the ~60/sec playhead updates during playback don't re-render every
 * thumbnail, only the (separate) playhead line element.
 *
 * The zoom effect's own indicator (ZoomEffectRow) renders in the SAME
 * scrollable w-max track as the thumbnails, directly below them, so both
 * share one scroll position and one pixel-accurate timeline width with no
 * manual measurement needed.
 */
import { memo, useMemo, useRef } from "react";
import { CropRectOverlay } from "./CropRectOverlay";
import { ZoomEffectRow } from "./ZoomEffectRow";
import { computeEffectiveCropRect, type CropRect, type ZoomEffect } from "@/lib/video/video_math";

const FrameTile = memo(function FrameTile({
  src,
  index,
  cropRect,
}: {
  src: string;
  index: number;
  cropRect: CropRect | null;
}) {
  return (
    <div className="relative h-full shrink-0">
      {/* eslint-disable-next-line @next/next/no-img-element -- short-lived data URLs, not a Next-optimizable remote image */}
      <img src={src} alt={`Frame at ${index}s`} className="h-full w-auto rounded-sm object-cover" />
      {cropRect && <CropRectOverlay cropRect={cropRect} />}
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
    <div className="h-full overflow-x-auto bg-neutral-950 px-2">
      {/* w-max so this div's own width is the strip's true total length --
          the playhead and ZoomEffectRow below both size/position relative
          to THIS box, so they stay aligned with the right thumbnail (and
          each other) at any scroll position. */}
      <div ref={trackRef} className="relative flex h-full w-max flex-col">
        <div onClick={handleClick} className="flex flex-1 cursor-pointer items-center gap-1">
          {thumbnails.map((src, index) => (
            <FrameTile key={index} src={src} index={index} cropRect={tileCropRects[index]} />
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
