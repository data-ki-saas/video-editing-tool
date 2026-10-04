"use client";

/**
 * Every Label (a TextOverlay with a `label:` template -- see
 * lib/video/labelTemplates.ts) on ONE shared row, unlike TextOverlayTrack's
 * row-per-overlay: labels never overlap, so they sit side by side like clips.
 * Drag a label's body to slide it along the row, drag either end to change how
 * long it shows; a plain click reopens LabelDialog. Dragging stops against the
 * neighbouring label (or the reel's ends) rather than overlapping or reordering
 * past it. Right-click offers Edit / Remove.
 *
 * Indices are into the FULL textOverlays array (the same index space
 * TextOverlayTrack and every handler in ThreePaneEditor use), so this just
 * skips non-label overlays instead of working from a filtered copy.
 */
import { useRef } from "react";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import type { TextOverlay } from "@/lib/video/video_math";
import {
  MIN_LABEL_DURATION_SECONDS,
  computeLabelGapBounds,
  describeLabelText,
  getLabelSpec,
} from "@/lib/video/labelTemplates";

// Pointer travel below this still counts as a click, not a drag.
const DRAG_THRESHOLD_PX = 3;

function LabelSegment({
  overlay,
  bounds,
  videoDurationSeconds,
  trackRef,
  onChangeRange,
  onCommitRange,
  onEdit,
  onDelete,
}: {
  overlay: TextOverlay;
  /** The free stretch around this label, from its neighbours. */
  bounds: { min: number; max: number };
  videoDurationSeconds: number;
  trackRef: React.RefObject<HTMLDivElement | null>;
  onChangeRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
  onCommitRange: (startTimeSeconds: number, endTimeSeconds: number) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();
  const spec = getLabelSpec(overlay.templateId);
  const summary = describeLabelText(overlay.text) || "Label";

  function startDrag(e: React.PointerEvent, mode: "move" | "start" | "end") {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const track = trackRef.current;
    if (!track || videoDurationSeconds <= 0) return;

    const trackWidth = track.getBoundingClientRect().width;
    const originX = e.clientX;
    const originStart = overlay.startTimeSeconds;
    const originEnd = overlay.endTimeSeconds;
    let moved = false;

    function compute(clientX: number): [number, number] {
      const dx = ((clientX - originX) / trackWidth) * videoDurationSeconds;
      if (mode === "move") {
        const length = originEnd - originStart;
        const start = Math.min(Math.max(originStart + dx, bounds.min), bounds.max - length);
        return [start, start + length];
      }
      if (mode === "start") {
        return [Math.min(Math.max(originStart + dx, bounds.min), originEnd - MIN_LABEL_DURATION_SECONDS), originEnd];
      }
      return [originStart, Math.max(Math.min(originEnd + dx, bounds.max), originStart + MIN_LABEL_DURATION_SECONDS)];
    }

    function handleMove(moveEvent: PointerEvent) {
      if (!moved && Math.abs(moveEvent.clientX - originX) < DRAG_THRESHOLD_PX) return;
      moved = true;
      onChangeRange(...compute(moveEvent.clientX));
    }
    function handleUp(upEvent: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      if (!moved) {
        // A press on the body with no real travel is a click; an edge press
        // that never moved just does nothing.
        if (mode === "move") onEdit();
        return;
      }
      onCommitRange(...compute(upEvent.clientX));
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  const leftPercent = videoDurationSeconds > 0 ? (overlay.startTimeSeconds / videoDurationSeconds) * 100 : 0;
  const widthPercent =
    videoDurationSeconds > 0 ? ((overlay.endTimeSeconds - overlay.startTimeSeconds) / videoDurationSeconds) * 100 : 0;
  // Tinted with the label's own main colour so segments read as the labels
  // they are; text colour follows the part's own foreground.
  const first = spec?.parts[0];

  return (
    <>
      <div
        onPointerDown={(e) => startDrag(e, "move")}
        onContextMenu={(e) =>
          openContextMenu(e, [
            { label: "Edit label", onSelect: onEdit },
            { label: "Remove", danger: true, onSelect: onDelete },
          ])
        }
        title={`"${summary}" -- drag to move, drag the ends to change duration, click to edit`}
        className="absolute top-0 flex h-full cursor-grab touch-none items-center overflow-hidden rounded-sm border border-white/40 px-2 active:cursor-grabbing"
        style={{
          left: `${leftPercent}%`,
          width: `${widthPercent}%`,
          background: first?.bg ?? "#2563eb",
          color: first?.fg ?? "#fff",
        }}
      >
        <span className="pointer-events-none select-none truncate text-[9px] font-medium">{summary}</span>
        <div
          onPointerDown={(e) => startDrag(e, "start")}
          className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize touch-none bg-black/30"
        />
        <div
          onPointerDown={(e) => startDrag(e, "end")}
          className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize touch-none bg-black/30"
        />
      </div>
      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </>
  );
}

export function LabelTrack({
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
  const trackRef = useRef<HTMLDivElement>(null);
  const labels = textOverlays
    .map((overlay, index) => ({ overlay, index }))
    .filter(({ overlay }) => getLabelSpec(overlay.templateId));
  if (labels.length === 0) return null;

  return (
    <div ref={trackRef} className="relative h-5 w-full shrink-0 rounded-sm bg-background/60">
      {labels.map(({ overlay, index }) => (
        <LabelSegment
          key={index}
          overlay={overlay}
          // Neighbour bounds come from the committed ranges: while one is
          // being dragged, the others haven't moved, so these hold steady.
          bounds={computeLabelGapBounds(
            textOverlays,
            index,
            overlay.startTimeSeconds,
            overlay.endTimeSeconds,
            videoDurationSeconds
          )}
          videoDurationSeconds={videoDurationSeconds}
          trackRef={trackRef}
          onChangeRange={(start, end) => onChangeRange(index, start, end)}
          onCommitRange={(start, end) => onCommitRange(index, start, end)}
          onEdit={() => onEdit(index)}
          onDelete={() => onDelete(index)}
        />
      ))}
    </div>
  );
}
