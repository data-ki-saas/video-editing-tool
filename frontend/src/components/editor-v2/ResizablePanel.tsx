"use client";

/**
 * A panel whose height can be resized by dragging a notch on ONE edge only
 * -- the opposite edge is this component's own container boundary and
 * never moves. `anchor="bottom"` (default) puts the fixed edge at the
 * bottom and the drag notch at the top; `anchor="top"` flips that, for a
 * panel that should stay pinned to the top of its stack and grow/shrink
 * downward instead (see Playground.tsx: the background-track strip is
 * anchored top, the volume graph anchored bottom, so the frame strip
 * between them gets whatever space is left rather than competing for a
 * fixed share of it).
 *
 * All the clamping math lives in lib/video/video_math.ts -- this component
 * only wires up pointer events and local height state.
 */
import { useRef, useState } from "react";
import { clampPanelHeight } from "@/lib/video/video_math";

export function ResizablePanel({
  label,
  initialHeightPx,
  anchor = "bottom",
  children,
}: {
  /** Accessible name for the drag handle, e.g. "image sequence" or "sound volume". */
  label: string;
  initialHeightPx: number;
  anchor?: "top" | "bottom";
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
    const deltaY = e.clientY - drag.pointerY;
    // anchor="bottom": the handle is on top -- dragging it up (negative
    // deltaY) makes the panel taller, since the bottom stays fixed.
    // anchor="top": the handle is on the bottom -- dragging it down
    // (positive deltaY) makes the panel taller, since the top stays fixed.
    // Same deltaY, opposite sign convention.
    const signedDelta = anchor === "bottom" ? -deltaY : deltaY;
    const candidateHeightPx = drag.heightAtDragStart + signedDelta;
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

  const handle = (
    <div
      onPointerDown={handlePointerDown}
      role="separator"
      aria-orientation="horizontal"
      aria-label={`Resize ${label}`}
      className="flex h-3 shrink-0 cursor-row-resize touch-none items-center justify-center"
    >
      <div className="h-1 w-10 rounded-full bg-border" />
    </div>
  );

  return (
    <div className="flex min-h-0 flex-col" style={{ height: heightPx }}>
      {anchor === "bottom" && handle}
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      {anchor === "top" && handle}
    </div>
  );
}
