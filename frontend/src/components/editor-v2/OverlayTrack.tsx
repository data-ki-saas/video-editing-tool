"use client";

/**
 * "How many frames is this overlay visible for" -- one row per image
 * overlay (see lib/video/video_math.ts's OverlayImage), each a draggable
 * segment spanning its own time range. One row PER overlay, rather than
 * packed into a single shared row like ZoomEffectsTrack, since -- unlike
 * zoom/pan transitions -- two overlays CAN legitimately overlap in time
 * (different images shown at once); a row each avoids needing collision
 * handling for that case. Right-click a segment to remove that overlay
 * entirely.
 */
import { useRef } from "react";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import type { OverlayImage } from "@/lib/video/video_math";

const MIN_DURATION_SECONDS = 0.2;

function OverlaySegment({
  overlay,
  imageUrl,
  videoDurationSeconds,
  onChangeRange,
  onCommitRange,
  onDelete,
}: {
  overlay: OverlayImage;
  imageUrl: string;
  videoDurationSeconds: number;
  onChangeRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
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
        onContextMenu={(e) => openContextMenu(e, [{ label: "Remove overlay", danger: true, onSelect: onDelete }])}
        title="Right-click to remove this overlay"
        className="absolute top-0 flex h-full items-center gap-1 overflow-hidden rounded-sm border border-cyan-400 bg-cyan-400/20 px-1"
        style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
      >
        {imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- a small presigned R2 thumbnail, not a Next-optimizable static asset
          <img src={imageUrl} alt="" className="h-3 w-3 shrink-0 rounded-sm object-cover" />
        )}
        <div
          onPointerDown={(e) => startEdgeDrag(e, "start")}
          className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-cyan-400/60"
        />
        <div
          onPointerDown={(e) => startEdgeDrag(e, "end")}
          className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-cyan-400/60"
        />
      </div>
      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}

export function OverlayTrack({
  overlayImages,
  assetUrlById,
  videoDurationSeconds,
  onChangeRange,
  onCommitRange,
  onDelete,
}: {
  overlayImages: OverlayImage[];
  assetUrlById: Record<string, string>;
  videoDurationSeconds: number;
  onChangeRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitRange: (overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) => void;
  onDelete: (overlayIndex: number) => void;
}) {
  if (overlayImages.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5">
      {overlayImages.map((overlay, index) => (
        <OverlaySegment
          key={index}
          overlay={overlay}
          imageUrl={assetUrlById[overlay.assetId] ?? ""}
          videoDurationSeconds={videoDurationSeconds}
          onChangeRange={(start, end) => onChangeRange(index, start, end)}
          onCommitRange={(start, end) => onCommitRange(index, start, end)}
          onDelete={() => onDelete(index)}
        />
      ))}
    </div>
  );
}
