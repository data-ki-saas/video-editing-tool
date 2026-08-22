"use client";

/**
 * The "shown below the timeline" indicators for every zoom/pan transition
 * on the clip (see lib/video/video_math.ts's ZoomEffect) -- one segment
 * per effect, all sharing this single row since transitions of this type
 * are mutually exclusive with each other and never overlap in time (see
 * transformations.ts's applyCropRectCommit, which clamps a newly-created
 * one against whatever's already there). A future, genuinely distinct
 * effect type would get its own array and its own row alongside this one,
 * not a redesign of this component.
 *
 * Each segment is filled with a repeating pattern that reads as the
 * effect's direction (dashes stretching apart for zoom out, pluses
 * packing together for zoom in), and is ALWAYS draggable at its edges,
 * regardless of where the playhead currently is -- dragging a segment's
 * edge is a direct manipulation of that segment, not something that needs
 * "this is the active one" gating the way the crop rectangle's own drag
 * handles do. A longer range means a slower transition, a shorter one a
 * faster one ("these are stretchable, showing the speed" per spec).
 * Resizing only ever changes start/end time; the start/end crop rects
 * themselves aren't touched here.
 */
import { useRef } from "react";
import type { ZoomEffect } from "@/lib/video/video_math";

const MIN_DURATION_SECONDS = 0.2;

function ZoomEffectSegment({
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
  const segmentRef = useRef<HTMLDivElement>(null);
  const isZoomingIn = zoomEffect.endRect.width < zoomEffect.startRect.width;

  function startDrag(e: React.PointerEvent, edge: "start" | "end") {
    e.preventDefault();
    e.stopPropagation();
    // The shared track (this segment's positioning parent) spans the full
    // timeline width -- needed here, not just this segment's own (much
    // narrower) box, to convert a pointer's pixel movement into seconds.
    const track = segmentRef.current?.parentElement;
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
    <div
      ref={segmentRef}
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
  );
}

export function ZoomEffectsTrack({
  zoomEffects,
  videoDurationSeconds,
  onChangeRange,
  onCommitRange,
}: {
  zoomEffects: ZoomEffect[];
  videoDurationSeconds: number;
  onChangeRange: (effectIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitRange: (effectIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
}) {
  if (zoomEffects.length === 0) return null;

  return (
    <div className="relative h-3 w-full shrink-0">
      {zoomEffects.map((zoomEffect, index) => (
        <ZoomEffectSegment
          key={index}
          zoomEffect={zoomEffect}
          videoDurationSeconds={videoDurationSeconds}
          onChangeRange={(start, end) => onChangeRange(index, start, end)}
          onCommitRange={(start, end) => onCommitRange(index, start, end)}
        />
      ))}
    </div>
  );
}
