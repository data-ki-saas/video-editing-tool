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
 * Each segment shows its epicenter -- the peak of the transition, e.g. max
 * zoom-in before easing back to normal -- as a green dot, draggable along
 * the segment to move WHEN the peak happens without touching the segment's
 * own start/end. Dragging either edge of the segment stretches/shortens
 * that half's duration instead (a longer half eases more slowly through
 * it); both the edges and the dot are ALWAYS draggable regardless of where
 * the playhead currently is -- direct manipulation of the segment itself,
 * not gated by an "active tile" concept the crop rectangle's own drag
 * handles use.
 */
import { useRef } from "react";
import type { ZoomEffect } from "@/lib/video/video_math";

const MIN_DURATION_SECONDS = 0.2;

function ZoomEffectSegment({
  zoomEffect,
  videoDurationSeconds,
  onChangeRange,
  onCommitRange,
  onChangeEpicenter,
  onCommitEpicenter,
}: {
  zoomEffect: ZoomEffect;
  videoDurationSeconds: number;
  onChangeRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
  onChangeEpicenter: (epicenterTimeSeconds: number) => void;
  onCommitEpicenter: (epicenterTimeSeconds: number) => void;
}) {
  const segmentRef = useRef<HTMLDivElement>(null);
  const isZoomingIn = zoomEffect.epicenterRect.width < zoomEffect.startRect.width;

  function startEdgeDrag(e: React.PointerEvent, edge: "start" | "end") {
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
    const epicenterTimeSeconds = zoomEffect.epicenterTimeSeconds;

    // An edge can't cross the epicenter -- that's the binding constraint
    // now (the two edges no longer clamp directly against each other).
    function computeNext(clientX: number): [number, number] {
      const dxSeconds = ((clientX - startX) / trackRect.width) * videoDurationSeconds;
      if (edge === "start") {
        const next = Math.min(Math.max(startTimeSeconds + dxSeconds, 0), epicenterTimeSeconds - MIN_DURATION_SECONDS);
        return [next, endTimeSeconds];
      }
      const next = Math.max(
        Math.min(endTimeSeconds + dxSeconds, videoDurationSeconds),
        epicenterTimeSeconds + MIN_DURATION_SECONDS
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

  function startEpicenterDrag(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const track = segmentRef.current?.parentElement;
    if (!track || videoDurationSeconds <= 0) return;

    const trackRect = track.getBoundingClientRect();
    const startX = e.clientX;
    const startEpicenterTimeSeconds = zoomEffect.epicenterTimeSeconds;
    const minTimeSeconds = zoomEffect.startTimeSeconds + MIN_DURATION_SECONDS;
    const maxTimeSeconds = zoomEffect.endTimeSeconds - MIN_DURATION_SECONDS;

    function computeNext(clientX: number): number {
      const dxSeconds = ((clientX - startX) / trackRect.width) * videoDurationSeconds;
      return Math.min(Math.max(startEpicenterTimeSeconds + dxSeconds, minTimeSeconds), maxTimeSeconds);
    }

    function handleMove(moveEvent: PointerEvent) {
      onChangeEpicenter(computeNext(moveEvent.clientX));
    }
    function handleUp(upEvent: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onCommitEpicenter(computeNext(upEvent.clientX));
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const leftPercent = videoDurationSeconds > 0 ? (zoomEffect.startTimeSeconds / videoDurationSeconds) * 100 : 0;
  const widthPercent =
    videoDurationSeconds > 0
      ? ((zoomEffect.endTimeSeconds - zoomEffect.startTimeSeconds) / videoDurationSeconds) * 100
      : 0;
  const segmentDurationSeconds = zoomEffect.endTimeSeconds - zoomEffect.startTimeSeconds;
  // Position of the dot WITHIN the segment's own box (0-100% of its width)
  // -- naturally stays inside the segment however the segment itself is
  // positioned/sized, with no extra coordinate translation needed.
  const epicenterPercentWithinSegment =
    segmentDurationSeconds > 0
      ? ((zoomEffect.epicenterTimeSeconds - zoomEffect.startTimeSeconds) / segmentDurationSeconds) * 100
      : 50;

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
        onPointerDown={(e) => startEdgeDrag(e, "start")}
        className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-accent/60"
      />
      <div
        onPointerDown={(e) => startEdgeDrag(e, "end")}
        className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-accent/60"
      />
      {/* The epicenter -- drag to move WHEN the peak happens. z-10 keeps it
          above the fill/edge handles so it's always grabbable even right
          next to one. */}
      <div
        onPointerDown={startEpicenterDrag}
        title="Drag to move the peak of this transition"
        className="absolute top-1/2 z-10 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border border-green-900 bg-green-500"
        style={{ left: `${epicenterPercentWithinSegment}%` }}
      />
    </div>
  );
}

export function ZoomEffectsTrack({
  zoomEffects,
  videoDurationSeconds,
  onChangeRange,
  onCommitRange,
  onChangeEpicenter,
  onCommitEpicenter,
}: {
  zoomEffects: ZoomEffect[];
  videoDurationSeconds: number;
  onChangeRange: (effectIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitRange: (effectIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onChangeEpicenter: (effectIndex: number, epicenterTimeSeconds: number) => void;
  onCommitEpicenter: (effectIndex: number, epicenterTimeSeconds: number) => void;
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
          onChangeEpicenter={(epicenter) => onChangeEpicenter(index, epicenter)}
          onCommitEpicenter={(epicenter) => onCommitEpicenter(index, epicenter)}
        />
      ))}
    </div>
  );
}
