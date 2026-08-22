"use client";

/**
 * A panel whose height can be resized by dragging a notch on its TOP edge
 * only -- the bottom edge is just this component's own container boundary
 * and never moves. Used by Playground.tsx for both the thumbnail strip and
 * the volume graph, so their "bottom fixed, top draggable +/-25%" resize
 * behavior lives in exactly one place instead of being duplicated per panel.
 *
 * All the clamping math lives in lib/video/video_math.ts -- this component
 * only wires up pointer events and local height state.
 */
import { useRef, useState } from "react";
import { clampPanelHeight } from "@/lib/video/video_math";

export function ResizablePanel({
  label,
  initialHeightPx,
  children,
}: {
  /** Accessible name for the drag handle, e.g. "image sequence" or "sound volume". */
  label: string;
  initialHeightPx: number;
  children: React.ReactNode;
}) {
  const [heightPx, setHeightPx] = useState(initialHeightPx);
  // Captured once per drag gesture (not derived from React state mid-drag)
  // so clamping is always relative to the fixed initialHeightPx.
  const dragStartRef = useRef<{ pointerY: number; heightAtDragStart: number } | null>(null);

  // Plain functions (not useCallback) on purpose -- handlePointerDown below
  // registers whichever instance exists at drag-start time directly on
  // `window`, and that same instance is what gets removed on pointerup, so
  // there's no staleness risk from re-creating them each render.
  function handlePointerMove(e: PointerEvent) {
    const drag = dragStartRef.current;
    if (!drag) return;
    // Dragging the top edge UP (pointer moves to smaller Y) makes the
    // panel TALLER, since the bottom edge is fixed in place.
    const deltaY = e.clientY - drag.pointerY;
    const candidateHeightPx = drag.heightAtDragStart - deltaY;
    setHeightPx(clampPanelHeight(initialHeightPx, candidateHeightPx));
  }

  function handlePointerUp() {
    dragStartRef.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
  }

  function handlePointerDown(e: React.PointerEvent) {
    dragStartRef.current = { pointerY: e.clientY, heightAtDragStart: heightPx };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  return (
    <div className="flex min-h-0 flex-col" style={{ height: heightPx }}>
      <div
        onPointerDown={handlePointerDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label={`Resize ${label}`}
        className="flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center"
      >
        <div className="h-1 w-10 rounded-full bg-border" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
