"use client";

/**
 * "How many frames is this caption visible for" -- one row per text
 * overlay (see lib/video/video_math.ts's TextOverlay), each a draggable
 * segment spanning its own time range. One row PER overlay, same reasoning
 * as OverlayTrack.tsx: overlays can legitimately overlap in time. Two
 * right-click actions: "Edit text" (reopens TextOverlayDialog pre-filled)
 * and "Remove" (deletes it outright).
 */
import { useRef } from "react";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import type { TextOverlay } from "@/lib/video/video_math";

const MIN_DURATION_SECONDS = 0.2;

function TextOverlaySegment({
  overlay,
  videoDurationSeconds,
  onChangeRange,
  onCommitRange,
  onEdit,
  onDelete,
}: {
  overlay: TextOverlay;
  videoDurationSeconds: number;
  onChangeRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();

  function startEdgeDrag(e: React.PointerEvent, edge: "start" | "end") {
    e.preventDefault();
    e.stopPropagation();
    const track = trackRef.current;
    if (!track || videoDurationSeconds <= 0) return;

    const trackRect = track.getBoundingClientRect();
    const startX = e.clientX;
    const startTimeSeconds = overlay.startTimeSeconds;
    const endTimeSeconds = overlay.endTimeSeconds;

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

  const leftPercent = videoDurationSeconds > 0 ? (overlay.startTimeSeconds / videoDurationSeconds) * 100 : 0;
  const widthPercent =
    videoDurationSeconds > 0 ? ((overlay.endTimeSeconds - overlay.startTimeSeconds) / videoDurationSeconds) * 100 : 0;

  return (
    <div ref={trackRef} className="relative h-4 w-full shrink-0">
      <div
        onContextMenu={(e) =>
          openContextMenu(e, [
            { label: "Edit text", onSelect: onEdit },
            { label: "Remove", danger: true, onSelect: onDelete },
          ])
        }
        title={`"${overlay.text}" -- right-click to edit or remove`}
        className="absolute top-0 flex h-full items-center overflow-hidden rounded-sm border border-emerald-400 bg-emerald-400/20 px-1"
        style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
      >
        <span className="pointer-events-none select-none truncate text-[9px] text-emerald-100">{overlay.text}</span>
        <div
          onPointerDown={(e) => startEdgeDrag(e, "start")}
          className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-emerald-400/60"
        />
        <div
          onPointerDown={(e) => startEdgeDrag(e, "end")}
          className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-emerald-400/60"
        />
      </div>
      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}

export function TextOverlayTrack({
  textOverlays,
  videoDurationSeconds,
  onChangeRange,
  onCommitRange,
  onEdit,
  onDelete,
}: {
  textOverlays: TextOverlay[];
  videoDurationSeconds: number;
  onChangeRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onEdit: (overlayIndex: number) => void;
  onDelete: (overlayIndex: number) => void;
}) {
  if (textOverlays.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5">
      {textOverlays.map((overlay, index) => (
        <TextOverlaySegment
          key={index}
          overlay={overlay}
          videoDurationSeconds={videoDurationSeconds}
          onChangeRange={(start, end) => onChangeRange(index, start, end)}
          onCommitRange={(start, end) => onCommitRange(index, start, end)}
          onEdit={() => onEdit(index)}
          onDelete={() => onDelete(index)}
        />
      ))}
    </div>
  );
}
