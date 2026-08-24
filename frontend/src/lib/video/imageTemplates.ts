/**
 * Ken Burns-style animation presets for an image clip in the base sequence
 * (the "Image Templates" toolbar tool -- see ImageTemplatesDialog.tsx).
 * Unlike lib/video/textTemplates.ts / transcriptCaptionTemplates.ts, this
 * catalog doesn't need its own style-rendering or Creatomate-property
 * mapping: a Ken Burns move IS just a ZoomEffect (video_math.ts), the exact
 * same mechanism ZoomEffectsTrack already drives for video pan/zoom, so the
 * live preview, the thumbnail strip, CanvasPlayer, and the Creatomate
 * compiler all already know how to animate one -- this file only decides
 * WHICH start/end rects a given template produces.
 *
 * Every template here is authored as a ONE-DIRECTIONAL move (start ->
 * target, no easing back), even though ZoomEffect's shape is normally
 * "ease in to a peak, then ease back out" (see video_math.ts's own comment
 * on ZoomEffect). That's done by setting `epicenterTimeSeconds ===
 * endTimeSeconds` and `endRect === epicenterRect`: computeEffectiveCropRect
 * then spends the effect's ENTIRE duration easing start -> epicenter (the
 * target), and the second half degenerates to zero length. No changes to
 * ZoomEffect/computeEffectiveCropRect were needed for this -- it already
 * falls out of the existing two-half interpolation.
 */
import { scaleCropRectCentered, type CropRect, type ZoomEffect } from "./video_math";

export type ImageTemplateId = "zoom-in" | "zoom-out" | "pan-left" | "pan-right" | "pan-up" | "pan-down";

export interface ImageTemplateOption {
  id: ImageTemplateId;
  name: string;
}

export const IMAGE_TEMPLATE_OPTIONS: ImageTemplateOption[] = [
  { id: "zoom-in", name: "Zoom In" },
  { id: "zoom-out", name: "Zoom Out" },
  { id: "pan-left", name: "Pan Left" },
  { id: "pan-right", name: "Pan Right" },
  { id: "pan-up", name: "Pan Up" },
  { id: "pan-down", name: "Pan Down" },
];

const DEFAULT_IMAGE_TEMPLATE_ID: ImageTemplateId = IMAGE_TEMPLATE_OPTIONS[0].id;

/** Defensive lookup, same pattern as transcriptCaptionTemplates.ts's
 * getTranscriptCaptionConfig -- falls back to the first template rather
 * than throwing if a stale/unknown id is ever persisted. */
export function getImageTemplateOption(templateId: string): ImageTemplateOption {
  return IMAGE_TEMPLATE_OPTIONS.find((option) => option.id === templateId) ?? IMAGE_TEMPLATE_OPTIONS[0];
}

// How tight zoom-in/zoom-out get, as a fraction of the base rect's size.
const ZOOM_SCALE = 0.72;
// A milder zoom for the pan templates -- just enough slack to slide the
// window from one edge to the other without ever showing outside the
// source frame.
const PAN_SCALE = 0.85;

/** A `scale`-sized rect, aligned to one edge (or centered) of `base` on
 * each axis, instead of scaleCropRectCentered's always-centered result --
 * what gives a pan template room to slide from one edge to the other. */
function alignedRect(
  base: CropRect,
  scale: number,
  hAlign: "left" | "center" | "right",
  vAlign: "top" | "center" | "bottom"
): CropRect {
  const width = base.width * scale;
  const height = base.height * scale;
  const x = hAlign === "left" ? base.x : hAlign === "right" ? base.x + base.width - width : base.x + (base.width - width) / 2;
  const y = vAlign === "top" ? base.y : vAlign === "bottom" ? base.y + base.height - height : base.y + (base.height - height) / 2;
  return { x, y, width, height };
}

/** The clip's starting rect and the rect it eases toward (held for the
 * degenerate second half -- see this file's module comment), for one
 * template. Unrecognized ids fall back to "zoom-in", same defensive
 * policy as getImageTemplateOption. */
function kenBurnsRects(templateId: string, base: CropRect): { startRect: CropRect; targetRect: CropRect } {
  switch (templateId as ImageTemplateId) {
    case "zoom-out":
      return { startRect: scaleCropRectCentered(base, ZOOM_SCALE), targetRect: base };
    case "pan-left":
      return { startRect: alignedRect(base, PAN_SCALE, "right", "center"), targetRect: alignedRect(base, PAN_SCALE, "left", "center") };
    case "pan-right":
      return { startRect: alignedRect(base, PAN_SCALE, "left", "center"), targetRect: alignedRect(base, PAN_SCALE, "right", "center") };
    case "pan-up":
      return { startRect: alignedRect(base, PAN_SCALE, "center", "bottom"), targetRect: alignedRect(base, PAN_SCALE, "center", "top") };
    case "pan-down":
      return { startRect: alignedRect(base, PAN_SCALE, "center", "top"), targetRect: alignedRect(base, PAN_SCALE, "center", "bottom") };
    case "zoom-in":
    default:
      return { startRect: base, targetRect: scaleCropRectCentered(base, ZOOM_SCALE) };
  }
}

/** Builds the ZoomEffect for an image clip spanning
 * [startTimeSeconds, startTimeSeconds + durationSeconds) -- used both when
 * an image clip is first added (transformations.ts's
 * applyAddImageSequenceClip) and by ImageTemplatesDialog's own live
 * preview, so the popup's preview and the real committed effect can never
 * drift apart. */
export function buildKenBurnsEffect(
  templateId: string,
  base: CropRect,
  startTimeSeconds: number,
  durationSeconds: number
): ZoomEffect {
  const endTimeSeconds = startTimeSeconds + durationSeconds;
  const { startRect, targetRect } = kenBurnsRects(templateId, base);
  return {
    startTimeSeconds,
    epicenterTimeSeconds: endTimeSeconds,
    endTimeSeconds,
    startRect,
    epicenterRect: targetRect,
    endRect: targetRect,
  };
}

export { DEFAULT_IMAGE_TEMPLATE_ID };
