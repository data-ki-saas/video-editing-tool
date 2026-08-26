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

// Which "axis" a template belongs to -- one pick per axis at a time
// (zoom-in/zoom-out are alternatives to each other; so are pan-left/right;
// so are pan-up/down), but any combination of DIFFERENT axes composes into
// one combined motion (see kenBurnsRects below and ImageTemplatesDialog's
// multi-select toggle logic).
export type ImageTemplateAxis = "zoom" | "pan-h" | "pan-v";

export const IMAGE_TEMPLATE_AXES: Record<ImageTemplateId, ImageTemplateAxis> = {
  "zoom-in": "zoom",
  "zoom-out": "zoom",
  "pan-left": "pan-h",
  "pan-right": "pan-h",
  "pan-up": "pan-v",
  "pan-down": "pan-v",
};

/** Resolves a persisted image SequenceEntry's template selection --
 * `templateIds` when present (the current, possibly-multi-axis shape),
 * falling back to the legacy single `templateId` string, and finally to the
 * default template if neither is set (shouldn't happen for entries created
 * through the dialog, which always requires >=1 axis selected). */
export function normalizeImageTemplateIds(entry: { templateIds?: string[] | null; templateId?: string | null }): string[] {
  if (entry.templateIds && entry.templateIds.length > 0) return entry.templateIds;
  if (entry.templateId) return [entry.templateId];
  return [DEFAULT_IMAGE_TEMPLATE_ID];
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

/** Same rect a plain centered scale would produce, but dispatches through
 * scaleCropRectCentered for the true center/center case rather than
 * alignedRect -- the two are mathematically equivalent but not bit-
 * identical (different float operation order), and a zoom-only selection
 * must match today's output exactly, not just visually. */
function rectForAlign(
  base: CropRect,
  scale: number,
  hAlign: "left" | "center" | "right",
  vAlign: "top" | "center" | "bottom"
): CropRect {
  return hAlign === "center" && vAlign === "center" ? scaleCropRectCentered(base, scale) : alignedRect(base, scale, hAlign, vAlign);
}

/** The clip's starting rect and the rect it eases toward (held for the
 * degenerate second half -- see this file's module comment), composed from
 * however many of the (up to 3) axis picks are present in `templateIds` --
 * one from the zoom axis, one from the horizontal-pan axis, one from the
 * vertical-pan axis, any subset combining into one motion (e.g. "zoom-in" +
 * "pan-right" zooms in while sliding toward the right side of the photo).
 * A zoom pick (if any) wins the overall scale/direction; pan picks (if any)
 * only set the alignment the zoomed/panned end leans toward. Reuses
 * alignedRect/scaleCropRectCentered verbatim -- no new rect-math
 * primitives. Falls back to "zoom-in" alone if `templateIds` is empty or
 * entirely unrecognized (shouldn't happen -- the dialog always requires
 * >=1 axis selected). */
function kenBurnsRects(templateIds: string[], base: CropRect): { startRect: CropRect; targetRect: CropRect } {
  const ids = new Set(templateIds);
  const zoomIn = ids.has("zoom-in");
  const zoomOut = ids.has("zoom-out") && !zoomIn;
  const panLeft = ids.has("pan-left");
  const panRight = ids.has("pan-right") && !panLeft;
  const panUp = ids.has("pan-up");
  const panDown = ids.has("pan-down") && !panUp;

  const targetHAlign = panLeft ? "left" : panRight ? "right" : "center";
  const startHAlign = panLeft ? "right" : panRight ? "left" : "center";
  const targetVAlign = panUp ? "top" : panDown ? "bottom" : "center";
  const startVAlign = panUp ? "bottom" : panDown ? "top" : "center";

  if (zoomIn) {
    return { startRect: base, targetRect: rectForAlign(base, ZOOM_SCALE, targetHAlign, targetVAlign) };
  }
  if (zoomOut) {
    return { startRect: rectForAlign(base, ZOOM_SCALE, targetHAlign, targetVAlign), targetRect: base };
  }
  if (panLeft || panRight || panUp || panDown) {
    return {
      startRect: rectForAlign(base, PAN_SCALE, startHAlign, startVAlign),
      targetRect: rectForAlign(base, PAN_SCALE, targetHAlign, targetVAlign),
    };
  }
  return kenBurnsRects(["zoom-in"], base);
}

/** Builds the ZoomEffect for an image clip spanning
 * [startTimeSeconds, startTimeSeconds + durationSeconds) -- used both when
 * an image clip is first added (transformations.ts's
 * applyAddImageSequenceClip) and by ImageTemplatesDialog's own live
 * preview, so the popup's preview and the real committed effect can never
 * drift apart. `templateIds` is one id per axis (see IMAGE_TEMPLATE_AXES),
 * composed by kenBurnsRects into a single motion. */
export function buildKenBurnsEffect(
  templateIds: string[],
  base: CropRect,
  startTimeSeconds: number,
  durationSeconds: number
): ZoomEffect {
  const endTimeSeconds = startTimeSeconds + durationSeconds;
  const { startRect, targetRect } = kenBurnsRects(templateIds, base);
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
