"use client";

/**
 * One row, one segment per background-music MusicClip (see
 * lib/video/video_math.ts) -- freely movable (body-drag) and resizable
 * (edge-drag), the same two gestures VideoOverlayTrack.tsx already gives a
 * video overlay, ported here for music (see that file's own
 * startEdgeDrag/startBodyDrag for the mechanics this is based on). Clips
 * share ONE row, sorted by time and neighbor-clamped so they never overlap
 * -- same "exclusive layout" packing VideoOverlayTrack uses for its own
 * Full-Screen/Split-Screen clips -- rather than TtsOverlayTrack/
 * VideoOverlayTrack's Picture-in-Picture group, which allows free overlap in
 * separate rows: layered, simultaneously-playing music beds aren't a case
 * this rail supports.
 *
 * Two DELIBERATE divergences from VideoOverlayTrack's own edge-drag, both
 * because a music clip's own "resize" means something different from a
 * video overlay's:
 *  - The END edge is allowed to stretch the on-timeline window PAST one
 *    play-through of the source (VideoOverlayTrack's own edge-drag hard-caps
 *    at `sourceCapEnd` today -- see its own comment on why that's now
 *    legacy-only there). Losing "a short music bed loops to fill the reel"
 *    would be a real regression from what background music could already do
 *    before this rail existed, so that cap is intentionally NOT ported.
 *    `repeatsWithinWindow`/the dimmed region below is what visualizes it.
 *  - The START edge moves BOTH startTimeSeconds AND sourceStartSeconds
 *    together -- true trim-from-the-source (drag the left edge in, reveal
 *    less of the track's own beginning), unlike VideoOverlayTrack's own left
 *    edge, which only slides the on-timeline window without ever touching
 *    its clip's sourceStartSeconds (that field is edited through a separate
 *    dialog there). This rail has no separate trim-start dialog, so
 *    edge-drag is the only way to set it.
 *
 * Each clip's own real source duration (musicClipSourceDurationSeconds,
 * probed once by ThreePaneEditor via getAudioDuration -- same cache
 * `handleAddMusicClip` populates) drives both the edge-drag clamp math and
 * the repeat-region visualization; Infinity (not yet probed) degrades
 * gracefully to "no repeat region," same as VideoOverlayTrack's own
 * `overlaySourceDurationSeconds` fallback.
 */
import { useRef } from "react";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { snapToNearest, MIN_MUSIC_CLIP_DURATION_SECONDS, type MusicClip } from "@/lib/video/video_math";

// Matches VideoOverlayTrack.tsx's own SNAP_THRESHOLD_PX -- same magnetic-
// snap feel across every draggable rail in this editor.
const SNAP_THRESHOLD_PX = 8;

function MusicClipSegment({
  clip,
  name,
  sourceDurationSeconds,
  videoDurationSeconds,
  prevBoundSeconds,
  nextBoundSeconds,
  snapPointsSeconds,
  onChangeRange,
  onCommitRange,
  onChangePosition,
  onCommitPosition,
  onDelete,
}: {
  clip: MusicClip;
  name: string;
  sourceDurationSeconds: number; // Infinity if not yet probed
  videoDurationSeconds: number;
  prevBoundSeconds: number;
  nextBoundSeconds: number;
  snapPointsSeconds: number[];
  onChangeRange: (start: number, end: number, sourceStart: number) => void;
  onCommitRange: (start: number, end: number, sourceStart: number) => void;
  onChangePosition: (start: number) => void;
  onCommitPosition: (start: number) => void;
  onDelete: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();

  function startEdgeDrag(e: React.PointerEvent, edge: "start" | "end") {
    e.preventDefault();
    e.stopPropagation(); // load-bearing: keeps this from also triggering startBodyDrag on the root
    const track = rootRef.current?.parentElement;
    if (!track || videoDurationSeconds <= 0) return;

    const trackRect = track.getBoundingClientRect();
    const startX = e.clientX;
    const { startTimeSeconds, endTimeSeconds, sourceStartSeconds } = clip;
    const snapThresholdSeconds = (SNAP_THRESHOLD_PX / trackRect.width) * videoDurationSeconds;

    function computeNext(clientX: number): [number, number, number] {
      const dxSeconds = ((clientX - startX) / trackRect.width) * videoDurationSeconds;
      if (edge === "start") {
        // Can't reveal earlier than the source's own real beginning --
        // startTimeSeconds - sourceStartSeconds is the timeline instant at
        // which sourceStartSeconds would hit 0.
        const minStart = Math.max(prevBoundSeconds, 0, startTimeSeconds - sourceStartSeconds);
        const maxStart = endTimeSeconds - MIN_MUSIC_CLIP_DURATION_SECONDS;
        const clamped = Math.min(Math.max(startTimeSeconds + dxSeconds, minStart), maxStart);
        const snapped = snapToNearest(clamped, snapPointsSeconds, snapThresholdSeconds);
        const nextStart = Math.min(Math.max(snapped, minStart), maxStart);
        const appliedDelta = nextStart - startTimeSeconds;
        return [nextStart, endTimeSeconds, sourceStartSeconds + appliedDelta];
      }
      // End edge -- deliberately no sourceCapEnd term, see this file's own
      // module comment on why a music clip may stretch past one
      // play-through of its source.
      const maxEnd = Math.min(nextBoundSeconds, videoDurationSeconds);
      const clamped = Math.max(Math.min(endTimeSeconds + dxSeconds, maxEnd), startTimeSeconds + MIN_MUSIC_CLIP_DURATION_SECONDS);
      const snapped = snapToNearest(clamped, snapPointsSeconds, snapThresholdSeconds);
      const next = Math.max(Math.min(snapped, maxEnd), startTimeSeconds + MIN_MUSIC_CLIP_DURATION_SECONDS);
      return [startTimeSeconds, next, sourceStartSeconds];
    }

    function handleMove(ev: PointerEvent) {
      onChangeRange(...computeNext(ev.clientX));
    }
    function handleUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onCommitRange(...computeNext(ev.clientX));
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  function startBodyDrag(e: React.PointerEvent) {
    e.preventDefault();
    const track = rootRef.current?.parentElement;
    if (!track || videoDurationSeconds <= 0) return;

    const trackRect = track.getBoundingClientRect();
    const startX = e.clientX;
    const durationSeconds = clip.endTimeSeconds - clip.startTimeSeconds;
    const minStart = prevBoundSeconds;
    const maxStart = Math.min(nextBoundSeconds, videoDurationSeconds) - durationSeconds;
    const snapThresholdSeconds = (SNAP_THRESHOLD_PX / trackRect.width) * videoDurationSeconds;

    function computeNext(clientX: number): number {
      const dxSeconds = ((clientX - startX) / trackRect.width) * videoDurationSeconds;
      const clamped = Math.min(Math.max(clip.startTimeSeconds + dxSeconds, minStart), Math.max(maxStart, minStart));
      const snapped = snapToNearest(clamped, snapPointsSeconds, snapThresholdSeconds);
      return Math.min(Math.max(snapped, minStart), Math.max(maxStart, minStart));
    }
    function handleMove(ev: PointerEvent) {
      onChangePosition(computeNext(ev.clientX));
    }
    function handleUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onCommitPosition(computeNext(ev.clientX));
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const leftPercent = videoDurationSeconds > 0 ? (clip.startTimeSeconds / videoDurationSeconds) * 100 : 0;
  const durationSeconds = clip.endTimeSeconds - clip.startTimeSeconds;
  const widthPercent = videoDurationSeconds > 0 ? (durationSeconds / videoDurationSeconds) * 100 : 0;

  // How much of the source is actually playable from its own trim-in point
  // onward -- what the clip's own window can loop across before repeating.
  // See this file's own module comment on why this (unlike
  // VideoOverlayTrack's equivalent, which ignores trim-in) subtracts
  // sourceStartSeconds: trim-in and overrun can both be true here at once.
  const hasKnownSourceDuration = Number.isFinite(sourceDurationSeconds) && sourceDurationSeconds > 0;
  const playableSourceSeconds = hasKnownSourceDuration ? Math.max(sourceDurationSeconds - clip.sourceStartSeconds, 0) : 0;
  const repeatsWithinWindow = hasKnownSourceDuration && playableSourceSeconds > 0 && playableSourceSeconds < durationSeconds;
  const repeatRegionPercent = repeatsWithinWindow ? ((durationSeconds - playableSourceSeconds) / durationSeconds) * 100 : 0;
  const loopTickPercents: number[] = [];
  if (repeatsWithinWindow) {
    for (let boundary = playableSourceSeconds; boundary < durationSeconds; boundary += playableSourceSeconds) {
      loopTickPercents.push((boundary / durationSeconds) * 100);
    }
  }

  return (
    <div ref={rootRef} className="relative h-5 w-full shrink-0">
      <div
        onPointerDown={startBodyDrag}
        onContextMenu={(e) => openContextMenu(e, [{ label: "Remove music", danger: true, onSelect: onDelete }])}
        title="Drag the middle to move, an edge to trim; right-click to remove"
        className="absolute top-0 flex h-full cursor-grab items-center overflow-hidden rounded-sm border border-accent-foreground/30 bg-accent px-1"
        style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
      >
        <span className="pointer-events-none select-none truncate text-[9px] text-accent-foreground">{name}</span>
        {repeatsWithinWindow && (
          <div
            className="pointer-events-none absolute inset-y-0 right-0 bg-black/35"
            style={{ width: `${repeatRegionPercent}%` }}
            title={`Repeats every ${playableSourceSeconds.toFixed(1)}s`}
          />
        )}
        {loopTickPercents.map((percent, tickIndex) => (
          <div
            key={tickIndex}
            title="Repeats here"
            className="pointer-events-none absolute inset-y-0 w-[2px] bg-white"
            style={{ left: `${percent}%`, boxShadow: "0 0 0 1px rgba(0,0,0,0.55)" }}
          />
        ))}
        <div
          onPointerDown={(e) => startEdgeDrag(e, "start")}
          className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-black/20"
        />
        <div
          onPointerDown={(e) => startEdgeDrag(e, "end")}
          className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-black/20"
        />
      </div>
      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}

export function BackgroundTrackStrip({
  musicClips,
  assetNameById,
  musicClipSourceDurationSeconds,
  videoDurationSeconds,
  currentTimeSeconds,
  snapPointsSeconds,
  pixelsPerSecond,
  scrollContainerRef,
  onScroll,
  onChangeRange,
  onCommitRange,
  onChangePosition,
  onCommitPosition,
  onDelete,
}: {
  musicClips: MusicClip[];
  assetNameById: Record<string, string>;
  musicClipSourceDurationSeconds: Record<string, number>;
  videoDurationSeconds: number;
  // Draws this rail's own segment of the shared red playhead line -- see
  // TimeRulerStrip's own module comment on why every rail in the group
  // draws its own segment at this same pixel offset instead of one element
  // spanning the whole stack.
  currentTimeSeconds: number;
  snapPointsSeconds: number[];
  pixelsPerSecond: number;
  scrollContainerRef: (el: HTMLDivElement | null) => void;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  onChangeRange: (clipIndex: number, start: number, end: number, sourceStart: number) => void;
  onCommitRange: (clipIndex: number, start: number, end: number, sourceStart: number) => void;
  onChangePosition: (clipIndex: number, start: number) => void;
  onCommitPosition: (clipIndex: number, start: number) => void;
  onDelete: (clipIndex: number) => void;
}) {
  const playheadLeftPx = Math.min(Math.max(currentTimeSeconds, 0), videoDurationSeconds) * pixelsPerSecond;

  if (musicClips.length === 0) {
    return (
      <div
        ref={scrollContainerRef}
        onScroll={onScroll}
        className="hide-scrollbar relative flex h-full items-center overflow-x-auto bg-neutral-950 px-2 text-xs text-muted"
      >
        No background music yet -- right-click a music asset to add it
        <div
          className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-red-500"
          style={{ left: playheadLeftPx }}
        />
      </div>
    );
  }

  const indexed = musicClips.map((clip, index) => ({ clip, index })).sort((a, b) => a.clip.startTimeSeconds - b.clip.startTimeSeconds);

  return (
    <div
      ref={scrollContainerRef}
      onScroll={onScroll}
      className="hide-scrollbar h-full overflow-x-auto bg-neutral-950 px-2"
    >
      <div className="relative h-full" style={{ width: videoDurationSeconds * pixelsPerSecond }}>
        {indexed.map(({ clip, index }, pos) => (
          <MusicClipSegment
            key={index}
            clip={clip}
            name={assetNameById[clip.assetId] ?? ""}
            sourceDurationSeconds={musicClipSourceDurationSeconds[clip.assetId] ?? Infinity}
            videoDurationSeconds={videoDurationSeconds}
            prevBoundSeconds={pos > 0 ? indexed[pos - 1].clip.endTimeSeconds : 0}
            nextBoundSeconds={pos < indexed.length - 1 ? indexed[pos + 1].clip.startTimeSeconds : videoDurationSeconds}
            snapPointsSeconds={snapPointsSeconds}
            onChangeRange={(start, end, sourceStart) => onChangeRange(index, start, end, sourceStart)}
            onCommitRange={(start, end, sourceStart) => onCommitRange(index, start, end, sourceStart)}
            onChangePosition={(start) => onChangePosition(index, start)}
            onCommitPosition={(start) => onCommitPosition(index, start)}
            onDelete={() => onDelete(index)}
          />
        ))}
        <div
          className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-red-500"
          style={{ left: playheadLeftPx }}
        />
      </div>
    </div>
  );
}
