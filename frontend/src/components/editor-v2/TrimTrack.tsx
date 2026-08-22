"use client";

/**
 * The trim indicator ABOVE the frame strip (unlike ZoomEffectsTrack/
 * FlipTrack, which sit below it): a thin gray line spanning the full
 * timeline. Click it once to drop a red dot; click again anywhere else on
 * the line to turn the stretch between the two clicks into a solid red
 * segment -- that section is genuinely cut from playback, not just marked
 * (see CanvasPlayer's skipTrimmedRanges). The pending dot is itself
 * draggable (before that second click) to move the starting point instead
 * of locking it to wherever the first click happened to land. Clicking
 * back on the pending dot's original spot without moving it cancels it
 * instead of placing a near-zero-length trim. Right-clicking an existing
 * red segment opens a context menu (the same one ProjectList/
 * AssetGallery/ZoomEffectsTrack use) to remove it.
 */
import { useRef } from "react";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import type { TrimRange } from "@/lib/video/video_math";

export function TrimTrack({
  trimRanges,
  pendingTrimStartSeconds,
  videoDurationSeconds,
  onClick,
  onMoveDot,
  onDeleteRange,
}: {
  trimRanges: TrimRange[];
  pendingTrimStartSeconds: number | null;
  videoDurationSeconds: number;
  onClick: (timeSeconds: number) => void;
  onMoveDot: (timeSeconds: number) => void;
  onDeleteRange: (rangeIndex: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (videoDurationSeconds <= 0 || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    const fraction = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    onClick(fraction * videoDurationSeconds);
  }

  // Dragging the pending dot repositions it directly (via onMoveDot) rather
  // than going through onClick's "first click / completing second click"
  // logic -- this is a reposition, not a click.
  function startDotDrag(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const track = trackRef.current;
    if (!track || videoDurationSeconds <= 0) return;
    const trackRect = track.getBoundingClientRect();

    function computeTime(clientX: number): number {
      const fraction = Math.min(Math.max((clientX - trackRect.left) / trackRect.width, 0), 1);
      return fraction * videoDurationSeconds;
    }

    function handleMove(moveEvent: PointerEvent) {
      onMoveDot(computeTime(moveEvent.clientX));
    }
    function handleUp(upEvent: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onMoveDot(computeTime(upEvent.clientX));
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const toPercent = (seconds: number) => (videoDurationSeconds > 0 ? (seconds / videoDurationSeconds) * 100 : 0);

  return (
    <div
      ref={trackRef}
      onClick={handleClick}
      title="Click to start a trim, click again elsewhere to cut that stretch"
      className="relative h-2 w-full shrink-0 cursor-pointer rounded-sm bg-neutral-600"
    >
      {trimRanges.map((range, index) => (
        <div
          key={index}
          onContextMenu={(e) => {
            e.stopPropagation();
            openContextMenu(e, [{ label: "Remove trim", danger: true, onSelect: () => onDeleteRange(index) }]);
          }}
          title="Right-click to remove this trim"
          className="absolute top-0 h-full rounded-sm bg-red-600"
          style={{
            left: `${toPercent(range.startTimeSeconds)}%`,
            width: `${toPercent(range.endTimeSeconds - range.startTimeSeconds)}%`,
          }}
        />
      ))}

      {pendingTrimStartSeconds !== null && (
        <div
          onPointerDown={startDotDrag}
          onClick={(e) => e.stopPropagation()}
          title="Drag to move the starting point"
          className="absolute top-1/2 z-10 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border border-red-900 bg-red-500"
          style={{ left: `${toPercent(pendingTrimStartSeconds)}%` }}
        />
      )}

      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}
