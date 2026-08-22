"use client";

/**
 * Renders a crop rectangle (CropRect fields are fractions, 0..1, of the
 * frame -- see lib/video/video_math.ts) over a video frame or thumbnail,
 * dimmed outside so the kept region reads clearly.
 *
 * Read-only (just the visual guide) unless `onChange`/`onCommit` are both
 * given, in which case it also grows a resize handle and becomes
 * draggable to reposition. Resizing always preserves the rect's own aspect
 * ratio -- the clip rectangle's chosen ratio is a hard constraint, not
 * something a drag should be able to distort -- by scaling both
 * dimensions from the fixed top-left corner together.
 *
 * `onChange` fires continuously while dragging (for live visual feedback);
 * `onCommit` fires once, on release, with the final rect -- callers should
 * only push an edit-history entry from onCommit, or every pixel of mouse
 * movement would spam the change list.
 */
import { useRef } from "react";
import type { CropRect } from "@/lib/video/video_math";

const MIN_SIZE_FRACTION = 0.1;

export function CropRectOverlay({
  cropRect,
  onChange,
  onCommit,
}: {
  cropRect: CropRect;
  onChange?: (next: CropRect) => void;
  onCommit?: (next: CropRect) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isInteractive = Boolean(onChange && onCommit);

  function startDrag(e: React.PointerEvent, mode: "move" | "resize") {
    if (!isInteractive) return;
    e.preventDefault();
    e.stopPropagation();
    const container = containerRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startRect = cropRect;
    const aspectRatio = startRect.width / startRect.height;

    function computeNext(clientX: number, clientY: number): CropRect {
      const dxFraction = (clientX - startX) / containerRect.width;
      const dyFraction = (clientY - startY) / containerRect.height;

      if (mode === "move") {
        return {
          ...startRect,
          x: Math.min(Math.max(startRect.x + dxFraction, 0), 1 - startRect.width),
          y: Math.min(Math.max(startRect.y + dyFraction, 0), 1 - startRect.height),
        };
      }

      // Resize from the fixed top-left corner -- averaging the two drag
      // axes (the second converted via the aspect ratio) lets a diagonal
      // drag feel natural while still landing on a single uniform scale.
      const maxWidthFraction = Math.min(1 - startRect.x, (1 - startRect.y) * aspectRatio);
      const rawWidth = startRect.width + (dxFraction + dyFraction * aspectRatio) / 2;
      const width = Math.min(Math.max(rawWidth, MIN_SIZE_FRACTION), maxWidthFraction);
      return { x: startRect.x, y: startRect.y, width, height: width / aspectRatio };
    }

    function handleMove(moveEvent: PointerEvent) {
      onChange?.(computeNext(moveEvent.clientX, moveEvent.clientY));
    }
    function handleUp(upEvent: PointerEvent) {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      onCommit?.(computeNext(upEvent.clientX, upEvent.clientY));
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0">
      <div
        onPointerDown={(e) => startDrag(e, "move")}
        // A drag's mouseup still fires a native `click` afterward (that
        // event is independent of pointerdown/pointermove and isn't
        // stopped by stopPropagation on those) -- swallowing it here stops
        // it from also bubbling up to e.g. FrameStrip's click-to-seek
        // handler right after a resize/reposition.
        onClick={(e) => isInteractive && e.stopPropagation()}
        className={"absolute border-2 border-white" + (isInteractive ? " pointer-events-auto cursor-move" : "")}
        style={{
          left: `${cropRect.x * 100}%`,
          top: `${cropRect.y * 100}%`,
          width: `${cropRect.width * 100}%`,
          height: `${cropRect.height * 100}%`,
          // A huge outset shadow, clipped by the parent's overflow-hidden --
          // dims everything outside this rect without a second mask element.
          boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.55)",
        }}
      >
        {isInteractive && (
          <div
            onPointerDown={(e) => startDrag(e, "resize")}
            onClick={(e) => e.stopPropagation()}
            className="pointer-events-auto absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-full border border-white bg-accent"
          />
        )}
      </div>
    </div>
  );
}
