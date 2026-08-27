"use client";

/**
 * One row, one segment per TTS narration overlay (see lib/video/video_math.ts's
 * TtsOverlay). A narration's own audio length is FIXED -- it comes from the
 * real generated speech (overlay.durationSeconds), not free authoring -- so
 * unlike TextOverlayTrack this rail only ever offers a body drag (move in
 * time, same gesture as VideoOverlayTrack's own body drag), never an edge
 * drag: there's no duration to trim. Clicking a segment (anywhere but its
 * own volume badge) reopens TtsOverlayDialog pre-filled, same as
 * right-clicking and choosing "Edit narration" -- mirrors TextOverlayTrack's
 * own "click = edit" convention. Each segment also carries its own volume
 * badge (see ./VolumeBadge.tsx), same "one rail fully defines this overlay"
 * reasoning as VideoOverlayTrack's own per-segment badge -- this rail is the
 * one direct-manipulation surface for a narration's own start time AND
 * volume (previously only a plain seconds input in the dialog itself, with
 * no volume control anywhere -- see that file's own module comment).
 */
import { useRef } from "react";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { VolumeBadge } from "./VolumeBadge";
import type { TtsOverlay } from "@/lib/video/video_math";

function TtsOverlaySegment({
  overlay,
  videoDurationSeconds,
  onChangePosition,
  onCommitPosition,
  onChangeVolume,
  onCommitVolume,
  onEdit,
  onDelete,
}: {
  overlay: TtsOverlay;
  videoDurationSeconds: number;
  onChangePosition: (startTimeSeconds: number) => void;
  onCommitPosition: (startTimeSeconds: number) => void;
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
        title={`"${overlay.text}" -- drag to move, click to edit, right-click to edit or remove`}
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
  onChangeVolume,
  onCommitVolume,
  onEdit,
  onDelete,
}: {
  ttsOverlays: TtsOverlay[];
  videoDurationSeconds: number;
  onChangePosition: (overlayIndex: number, startTimeSeconds: number) => void;
  onCommitPosition: (overlayIndex: number, startTimeSeconds: number) => void;
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
          onChangeVolume={(level) => onChangeVolume(index, level)}
          onCommitVolume={(level) => onCommitVolume(index, level)}
          onEdit={() => onEdit(index)}
          onDelete={() => onDelete(index)}
        />
      ))}
    </div>
  );
}
