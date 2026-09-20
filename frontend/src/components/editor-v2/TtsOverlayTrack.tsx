"use client";

/**
 * One row, one segment per TTS narration overlay (see lib/video/video_math.ts's
 * TtsOverlay). Body drag moves it in time (same gesture as VideoOverlayTrack's
 * own body drag). The right edge can also be dragged to trim the narration's
 * tail -- durationSeconds can shrink (truncate from the end) or grow back out,
 * capped at overlay.sourceDurationSeconds (the real synthesized audio's full
 * length: trimming can shorten what plays, never fabricate audio beyond what
 * was actually generated). There's deliberately no start/left-edge drag --
 * unlike a video overlay or music clip, cutting into the FRONT of a narration
 * would need to also shift wordTimings/tagAnchors (all relative to the
 * overlay's own start), which regenerating the script already does for free.
 * Clicking a segment (anywhere but its own volume badge or the edge handle)
 * reopens TtsOverlayDialog pre-filled, same as right-clicking and choosing
 * "Edit narration" -- mirrors TextOverlayTrack's own "click = edit"
 * convention. Each segment also carries its own volume badge (see
 * ./VolumeBadge.tsx), same "one rail fully defines this overlay" reasoning as
 * VideoOverlayTrack's own per-segment badge -- this rail is the one
 * direct-manipulation surface for a narration's own start time, duration, AND
 * volume (previously only a plain seconds input in the dialog itself, with
 * no volume control anywhere -- see that file's own module comment).
 */
import { useRef } from "react";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { VolumeBadge } from "./VolumeBadge";
import { MIN_TTS_OVERLAY_DURATION_SECONDS, type TtsOverlay } from "@/lib/video/video_math";

function TtsOverlaySegment({
  overlay,
  videoDurationSeconds,
  onChangePosition,
  onCommitPosition,
  onChangeDuration,
  onCommitDuration,
  onChangeVolume,
  onCommitVolume,
  onEdit,
  onDelete,
}: {
  overlay: TtsOverlay;
  videoDurationSeconds: number;
  onChangePosition: (startTimeSeconds: number) => void;
  onCommitPosition: (startTimeSeconds: number) => void;
  onChangeDuration: (durationSeconds: number) => void;
  onCommitDuration: (durationSeconds: number) => void;
  onChangeVolume: (level: number) => void;
  onCommitVolume: (level: number) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();
  const durationSeconds = overlay.durationSeconds;

  function startBodyDrag(e: React.PointerEvent) {
    e.preventDefault();
    const track = rootRef.current?.parentElement;
    if (!track || videoDurationSeconds <= 0) return;

    const trackRect = track.getBoundingClientRect();
    const startX = e.clientX;
    const maxStart = Math.max(videoDurationSeconds - durationSeconds, 0);

    function computeNext(clientX: number): number {
      const dxSeconds = ((clientX - startX) / trackRect.width) * videoDurationSeconds;
      return Math.min(Math.max(overlay.startTimeSeconds + dxSeconds, 0), maxStart);
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

  // Right-edge drag: trims (or grows back) the narration's tail, capped at
  // the real synthesized audio's own length -- see this file's own module
  // comment. Falls back to durationSeconds itself for any overlay saved
  // before sourceDurationSeconds existed, which just pins that ceiling to
  // wherever it already is (no regression, but no grow-back either until
  // the script is regenerated).
  function startEdgeDrag(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation(); // load-bearing: keeps this from also triggering startBodyDrag on the root
    const track = rootRef.current?.parentElement;
    if (!track || videoDurationSeconds <= 0) return;

    const trackRect = track.getBoundingClientRect();
    const startX = e.clientX;
    const sourceDurationSeconds = overlay.sourceDurationSeconds ?? overlay.durationSeconds;
    const maxDuration = Math.max(
      Math.min(sourceDurationSeconds, videoDurationSeconds - overlay.startTimeSeconds),
      MIN_TTS_OVERLAY_DURATION_SECONDS
    );

    function computeNext(clientX: number): number {
      const dxSeconds = ((clientX - startX) / trackRect.width) * videoDurationSeconds;
      return Math.min(Math.max(durationSeconds + dxSeconds, MIN_TTS_OVERLAY_DURATION_SECONDS), maxDuration);
    }
    function handleMove(ev: PointerEvent) {
      onChangeDuration(computeNext(ev.clientX));
    }
    function handleUp(ev: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onCommitDuration(computeNext(ev.clientX));
    }
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const leftPercent = videoDurationSeconds > 0 ? (overlay.startTimeSeconds / videoDurationSeconds) * 100 : 0;
  const widthPercent = videoDurationSeconds > 0 ? (durationSeconds / videoDurationSeconds) * 100 : 0;

  return (
    <div ref={rootRef} className="relative h-5 w-full shrink-0">
      <div
        onPointerDown={startBodyDrag}
        onClick={onEdit}
        onContextMenu={(e) =>
          openContextMenu(e, [
            { label: "Edit narration", onSelect: onEdit },
            { label: "Remove narration", danger: true, onSelect: onDelete },
          ])
        }
        title={`"${overlay.text}" -- drag to move, drag right edge to trim, click to edit, right-click to edit or remove`}
        className="absolute top-0 flex h-full cursor-grab items-center gap-1 overflow-hidden rounded-sm border border-fuchsia-400 bg-fuchsia-400/20 px-1"
        style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
      >
        <span className="pointer-events-none select-none truncate text-[9px] text-fuchsia-100">{overlay.text}</span>
        {/* stopPropagation on click (not just pointerdown) -- otherwise a
            click on the badge bubbles up to the segment root's own onClick
            and reopens the edit dialog right after toggling the popup. */}
        <div onClick={(e) => e.stopPropagation()}>
          <VolumeBadge value={overlay.volume} onChange={onChangeVolume} onCommit={onCommitVolume} colorClassName="to-fuchsia-500" />
        </div>
        <div
          onPointerDown={startEdgeDrag}
          onClick={(e) => e.stopPropagation()}
          className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-fuchsia-100/30"
        />
      </div>
      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}

export function TtsOverlayTrack({
  ttsOverlays,
  videoDurationSeconds,
  onChangePosition,
  onCommitPosition,
  onChangeDuration,
  onCommitDuration,
  onChangeVolume,
  onCommitVolume,
  onEdit,
  onDelete,
}: {
  ttsOverlays: TtsOverlay[];
  videoDurationSeconds: number;
  onChangePosition: (overlayIndex: number, startTimeSeconds: number) => void;
  onCommitPosition: (overlayIndex: number, startTimeSeconds: number) => void;
  onChangeDuration: (overlayIndex: number, durationSeconds: number) => void;
  onCommitDuration: (overlayIndex: number, durationSeconds: number) => void;
  onChangeVolume: (overlayIndex: number, level: number) => void;
  onCommitVolume: (overlayIndex: number, level: number) => void;
  onEdit: (overlayIndex: number) => void;
  onDelete: (overlayIndex: number) => void;
}) {
  if (ttsOverlays.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5">
      {ttsOverlays.map((overlay, index) => (
        <TtsOverlaySegment
          key={index}
          overlay={overlay}
          videoDurationSeconds={videoDurationSeconds}
          onChangePosition={(start) => onChangePosition(index, start)}
          onCommitPosition={(start) => onCommitPosition(index, start)}
          onChangeDuration={(duration) => onChangeDuration(index, duration)}
          onCommitDuration={(duration) => onCommitDuration(index, duration)}
          onChangeVolume={(level) => onChangeVolume(index, level)}
          onCommitVolume={(level) => onCommitVolume(index, level)}
          onEdit={() => onEdit(index)}
          onDelete={() => onDelete(index)}
        />
      ))}
    </div>
  );
}
