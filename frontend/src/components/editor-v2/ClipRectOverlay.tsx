"use client";

/**
 * Draws the "how this will be cropped" guide on top of CanvasPlayer's
 * canvas: the largest `clipRectRatio` rectangle that fits the source frame
 * (lib/video/video_math.ts's computeMaxCoverageCropRect), dimmed outside so
 * the kept region reads clearly.
 *
 * Purely a visual guide for now -- it doesn't yet actually crop the
 * rendered pixels (see UserActions.tsx's Transform group: "Crop happens
 * automatically from the clip rectangle" is the next step to build on top
 * of this).
 */
import { computeMaxCoverageCropRect } from "@/lib/video/video_math";

export function ClipRectOverlay({
  sourceWidth,
  sourceHeight,
  clipRectRatio,
}: {
  sourceWidth: number;
  sourceHeight: number;
  clipRectRatio: number;
}) {
  const crop = computeMaxCoverageCropRect(sourceWidth, sourceHeight, clipRectRatio);

  return (
    <div
      className="pointer-events-none absolute border-2 border-white"
      style={{
        left: `${(crop.x / sourceWidth) * 100}%`,
        top: `${(crop.y / sourceHeight) * 100}%`,
        width: `${(crop.width / sourceWidth) * 100}%`,
        height: `${(crop.height / sourceHeight) * 100}%`,
        // A huge outset shadow, clipped by the parent's overflow-hidden --
        // dims everything outside this rect without needing a second,
        // separately-positioned mask element.
        boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.55)",
      }}
    />
  );
}
