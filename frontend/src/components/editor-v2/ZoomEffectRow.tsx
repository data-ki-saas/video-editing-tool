"use client";

/**
 * The "shown below the timeline" indicator for a zoom in/out effect (see
 * lib/video/video_math.ts's ZoomEffect) -- a segment spanning its
 * [startTimeSeconds, endTimeSeconds] range, filled with a repeating
 * pattern that reads as the effect's direction (dashes stretching apart
 * for zoom out, pluses packing together for zoom in), per spec. Only one
 * effect is supported yet, so only one row/segment ever shows -- if
 * multiple effects exist in the future, show the one currently selected
 * from the change history (FeedbackArea) here, not all of them at once,
 * to avoid clutter.
 *
 * Dragging either edge changes the effect's time range -- a longer range
 * means a slower zoom, a shorter one a faster zoom ("these are
 * stretchable, showing the speed of zoom in or out" per spec). Resizing
 * only ever changes start/end time; the start/end crop rects themselves
 * aren't touched here.
 */
import { useRef } from "react";
import type { ZoomEffect } from "@/lib/video/video_math";

const MIN_DURATION_SECONDS = 0.2;

export function ZoomEffectRow({
  zoomEffect,
  videoDurationSeconds,
  onChangeRange,
  onCommitRange,
}: {
  zoomEffect: ZoomEffect;
  videoDurationSeconds: number;
  onChangeRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const isZoomingIn = zoomEffect.endRect.width < zoomEffect.startRect.width;

  function startDrag(e: React.PointerEvent, edge: "start" | "end") {
    e.preventDefault();
    e.stopPropagation();
    const track = trackRef.current;
    if (!track || videoDurationSeconds <= 0) return;

    const trackRect = track.getBoundingClientRect();
    const startX = e.clientX;
    const startTimeSeconds = zoomEffect.startTimeSeconds;
    const endTimeSeconds = zoomEffect.endTimeSeconds;

    function computeNext(clientX: number): [number, number] {
      const dxSeconds = ((clientX - startX) / trackRect.width) * videoDurationSeconds;
      if (edge === "start") {
        const next = Math.min(Math.max(startTimeSeconds + dxSeconds, 0), endTimeSeconds - MIN_DURATION_SECONDS);
        return [next, endTimeSeconds];
      }
      const next = Math.max(
        Math.min(endTimeSeconds + dxSeconds, videoDurationSeconds),
        startTimeSeconds + MIN_DURATION_SECONDS
      );
      return [startTimeSeconds, next];
    }

    function handleMove(moveEvent: PointerEvent) {
      onChangeRange(...computeNext(moveEvent.clientX));
    }
    function handleUp(upEvent: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onCommitRange(...computeNext(upEvent.clientX));
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const leftPercent = videoDurationSeconds > 0 ? (zoomEffect.startTimeSeconds / videoDurationSeconds) * 100 : 0;
  const widthPercent =
    videoDurationSeconds > 0
      ? ((zoomEffect.endTimeSeconds - zoomEffect.startTimeSeconds) / videoDurationSeconds) * 100
      : 0;

  return (
    <div ref={trackRef} className="relative h-3 w-full shrink-0">
      <div
        title={isZoomingIn ? "Zoom in" : "Zoom out"}
        className="absolute top-0 flex h-full items-center justify-center overflow-hidden rounded-sm border border-accent bg-accent/20 text-[8px] leading-none text-accent"
        style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
      >
        <span className="pointer-events-none select-none whitespace-nowrap tracking-widest">
          {isZoomingIn ? "++++++++++++++++++++" : "--------------------"}
        </span>
        <div
          onPointerDown={(e) => startDrag(e, "start")}
          className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-accent/60"
        />
        <div
          onPointerDown={(e) => startDrag(e, "end")}
          className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-accent/60"
        />
      </div>
    </div>
  );
}
