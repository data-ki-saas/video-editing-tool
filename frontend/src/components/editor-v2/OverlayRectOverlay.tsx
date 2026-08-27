"use client";

/**
 * Renders one overlay's position/size rectangle (fractions of the frame --
 * see lib/video/video_math.ts's ImageOverlayClip/TextOverlay) on top of a
 * video frame or thumbnail, showing its actual content inside: an image
 * (pass `imageUrl`) or, for a text overlay, `renderInner` (a
 * TextOverlayCanvas -- see FrameStrip.tsx). Read-only unless onChange/
 * onCommit are both given -- only the active tile wires these (see
 * FrameStrip.tsx), matching CropRectOverlay's pattern -- in which case
 * dragging the body moves it and the corner handle resizes it (free-form,
 * not aspect-locked -- kept simple for now).
 *
 * Styled distinctly from CropRectOverlay (a dashed cyan border, no
 * dimming outside it) since both can be visible on the same tile at once --
 * an overlay sits ON TOP of the clip's crop rectangle, not instead of it,
 * so they need to read as two different kinds of box.
 */
import { useRef, type ReactNode } from "react";
import type { CropRect } from "@/lib/video/video_math";

const MIN_SIZE_FRACTION = 0.05;

export function OverlayRectOverlay({
  rect,
  imageUrl,
  renderInner,
  onChange,
  onCommit,
  borderColorClassName = "border-cyan-400",
  handleColorClassName = "bg-cyan-400",
}: {
  rect: CropRect;
  imageUrl?: string;
  /** Replaces the default `<img>` content -- used for text overlays,
   * which have no imageUrl at all. */
  renderInner?: ReactNode;
  onChange?: (next: CropRect) => void;
  onCommit?: (next: CropRect) => void;
  /** Lets a caller distinguish its own overlay kind from a plain image
   * overlay's default cyan when both can appear on the same tile at once
   * -- see FrameStrip.tsx's Picture-in-Picture video overlays, styled
   * violet instead. */
  borderColorClassName?: string;
  handleColorClassName?: string;
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
    const startRect = rect;

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

      const width = Math.min(Math.max(startRect.width + dxFraction, MIN_SIZE_FRACTION), 1 - startRect.x);
      const height = Math.min(Math.max(startRect.height + dyFraction, MIN_SIZE_FRACTION), 1 - startRect.y);
      return { ...startRect, width, height };
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

  function stopClickBubble(e: React.MouseEvent) {
    // Same reasoning as CropRectOverlay's stopClickBubble -- a drag's
    // mouseup still fires a native `click` afterward, which would
    // otherwise bubble up to FrameStrip's click-to-seek handler.
    e.stopPropagation();
  }

  return (
    <div ref={containerRef} className="pointer-events-none absolute inset-0">
      <div
        onPointerDown={(e) => startDrag(e, "move")}
        onClick={(e) => isInteractive && stopClickBubble(e)}
        className={
          `absolute overflow-hidden border-2 border-dashed ${borderColorClassName}` +
          (isInteractive ? " pointer-events-auto cursor-move" : "")
        }
        style={{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.width * 100}%`,
          height: `${rect.height * 100}%`,
        }}
      >
        {renderInner ?? (
          // eslint-disable-next-line @next/next/no-img-element -- a presigned R2 asset URL, not a Next-optimizable static asset
          <img src={imageUrl} alt="" className="h-full w-full object-cover" />
        )}

        {isInteractive && (
          <div
            onPointerDown={(e) => startDrag(e, "resize")}
            onClick={stopClickBubble}
            className={`pointer-events-auto absolute -bottom-1.5 -right-1.5 z-10 h-3 w-3 cursor-nwse-resize rounded-full border border-white ${handleColorClassName}`}
          />
        )}
      </div>
    </div>
  );
}
