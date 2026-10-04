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
import type { CropRect, OverlayFraming } from "@/lib/video/video_math";

const MIN_SIZE_FRACTION = 0.05;
// With allowOffscreen: how much of the rect must stay inside the frame, and
// the largest it may grow to (as a multiple of the frame's width/height).
const MIN_VISIBLE_FRACTION = 0.25;
const MAX_OFFSCREEN_SIZE_FRACTION = 2;

export function OverlayRectOverlay({
  rect,
  imageUrl,
  cssFilter,
  framing,
  renderInner,
  onChange,
  onCommit,
  borderColorClassName = "border-cyan-400",
  handleColorClassName = "bg-cyan-400",
  bottomOverhangFraction = 0,
  lockAspect = false,
  allowOffscreen = false,
}: {
  rect: CropRect;
  imageUrl?: string;
  /** CSS `filter` string for this overlay's own color filter (see
   * filterPresets.ts) -- same cssFilter CanvasPlayer applies via ctx.filter,
   * so this PiP thumbnail matches the live preview. Ignored when
   * renderInner is given (text overlays have no filter of their own). */
  cssFilter?: string;
  /** This overlay's own pan/zoom/flip (see video_math.ts's OverlayFraming) --
   * applied to `imageUrl` the same way VideoOverlayFramingDialog/
   * ImageOverlayFramingDialog's own CoverFramingRegion renders it (a
   * zoom-scaled wrapper anchored at the pan point, object-position for the
   * pan itself, a separate flip transform on the <img>), so this rail tile
   * shows the same crop the live CanvasPlayer preview does instead of
   * always a plain, un-panned/un-zoomed `object-cover` of the raw asset.
   * Only ever given (and only ever meaningful) for a Picture-in-Picture box
   * -- FrameStrip.tsx never renders a Full-Screen/Split-Screen overlay
   * through this component. Undefined falls back to the old plain
   * `object-cover` rendering (text overlays don't pass imageUrl at all, so
   * this only actually matters when imageUrl is also given). */
  framing?: OverlayFraming;
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
  /** Share of the rect's own height that may hang past the frame's bottom
   * edge -- for content that doesn't fill its rect (an avatar's feet stop
   * short of the rig's bottom), so the VISIBLE content can still touch the
   * bottom of the video. 0 (the default) keeps the rect inside the frame. */
  bottomOverhangFraction?: number;
  /** Resizing keeps the rect's current shape (a prop sized to its artwork,
   * where a free corner drag would re-crop it). */
  lockAspect?: boolean;
  /** The rect may be dragged partly past any frame edge (a prop whose
   * artwork has transparent padding or a soft shadow can then still sit
   * flush with the edge). A sliver (MIN_VISIBLE_FRACTION of the rect) always
   * stays inside so it can be grabbed again. */
  allowOffscreen?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isInteractive = Boolean(onChange && onCommit);
  // How far the rect currently hangs below/right of the frame, as a share of
  // its own size -- the resize handle is lifted by that much so it stays
  // grabbable.
  const hangingBelowPercent = Math.max(0, ((rect.y + rect.height - 1) / rect.height) * 100);
  const hangingRightPercent = allowOffscreen ? Math.max(0, ((rect.x + rect.width - 1) / rect.width) * 100) : 0;

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

      if (mode === "move" && allowOffscreen) {
        return {
          ...startRect,
          x: Math.min(Math.max(startRect.x + dxFraction, -startRect.width * (1 - MIN_VISIBLE_FRACTION)), 1 - startRect.width * MIN_VISIBLE_FRACTION),
          y: Math.min(Math.max(startRect.y + dyFraction, -startRect.height * (1 - MIN_VISIBLE_FRACTION)), 1 - startRect.height * MIN_VISIBLE_FRACTION),
        };
      }

      if (mode === "move") {
        return {
          ...startRect,
          x: Math.min(Math.max(startRect.x + dxFraction, 0), 1 - startRect.width),
          y: Math.min(Math.max(startRect.y + dyFraction, 0), 1 - startRect.height * (1 - bottomOverhangFraction)),
        };
      }

      if (lockAspect) {
        const heightPerWidth = startRect.height / startRect.width;
        const minWidth = Math.max(MIN_SIZE_FRACTION, MIN_SIZE_FRACTION / heightPerWidth);
        const maxWidth = allowOffscreen
          ? Math.min(MAX_OFFSCREEN_SIZE_FRACTION, MAX_OFFSCREEN_SIZE_FRACTION / heightPerWidth)
          : Math.min(1 - startRect.x, (1 - startRect.y) / heightPerWidth);
        const lockedWidth = Math.min(Math.max(startRect.width + dxFraction, minWidth), Math.max(maxWidth, minWidth));
        return { ...startRect, width: lockedWidth, height: lockedWidth * heightPerWidth };
      }

      const width = Math.min(Math.max(startRect.width + dxFraction, MIN_SIZE_FRACTION), 1 - startRect.x);
      const height = Math.min(
        Math.max(startRect.height + dyFraction, MIN_SIZE_FRACTION),
        (1 - startRect.y) / (1 - bottomOverhangFraction)
      );
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
        {renderInner ??
          (framing ? (
            <div
              className="pointer-events-none absolute inset-0 overflow-hidden"
              style={{ transform: `scale(${framing.zoom})`, transformOrigin: `${framing.panX * 100}% ${framing.panY * 100}%` }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a presigned R2 asset URL, not a Next-optimizable static asset */}
              <img
                src={imageUrl}
                alt=""
                className="pointer-events-none absolute inset-0 h-full w-full object-cover"
                style={{
                  objectPosition: `${framing.panX * 100}% ${framing.panY * 100}%`,
                  filter: cssFilter,
                  transform: `scale(${framing.flipHorizontal ? -1 : 1}, ${framing.flipVertical ? -1 : 1})`,
                }}
              />
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- a presigned R2 asset URL, not a Next-optimizable static asset
            <img src={imageUrl} alt="" className="h-full w-full object-cover" style={{ filter: cssFilter }} />
          ))}

        {isInteractive && (
          <div
            onPointerDown={(e) => startDrag(e, "resize")}
            onClick={stopClickBubble}
            style={{
              ...(hangingBelowPercent > 0 ? { bottom: `${hangingBelowPercent}%` } : null),
              ...(hangingRightPercent > 0 ? { right: `${hangingRightPercent}%` } : null),
            }}
            className={`pointer-events-auto absolute ${hangingBelowPercent > 0 ? "bottom-0" : "-bottom-1.5"} ${hangingRightPercent > 0 ? "right-0" : "-right-1.5"} z-10 h-3 w-3 cursor-nwse-resize rounded-full border border-white ${handleColorClassName}`}
          />
        )}
      </div>
    </div>
  );
}
