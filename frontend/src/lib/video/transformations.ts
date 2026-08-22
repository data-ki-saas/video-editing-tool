/**
 * Centralizes the "given the current edit-selections state and a user
 * action, what should the new state be" decision logic for every
 * frame-affecting transformation (clip-rectangle placement, zoom in/out,
 * and whatever comes next -- pan/tilt, flip/mirror, trim). ThreePaneEditor
 * calls these and pushes the result through useEditHistory; it should
 * never contain this decision logic inline itself.
 *
 * This matters as a separate layer from video_math.ts: video_math.ts holds
 * pure geometry (how to build/interpolate/scale a CropRect), this module
 * holds the higher-level rules for how a user action maps onto that
 * geometry given whatever's already there -- e.g. a crop drag either
 * starts a new transition or reshapes an existing one's nearer endpoint,
 * depending on where the playhead is. Keeping that decision logic in one
 * place is what makes it tractable to keep consistent as more
 * transformation types (pan/tilt, flip, trim) start interacting with each
 * other the same way crop and zoom already do.
 */
import type { EditSelectionsSnapshot } from "@/lib/projects";
import { computeMaxCoverageCropFraction, type CropRect } from "./video_math";

export const DEFAULT_ZOOM_DURATION_SECONDS = 2;

export interface TransformationResult {
  /** Human-readable label for the change-history entry (FeedbackArea). */
  label: string;
  state: EditSelectionsSnapshot;
}

/** Picking a clip-rectangle ratio always resets to a fresh max-coverage
 * crop and drops any zoom effect -- a new ratio invalidates whatever
 * transition was built on the old one's geometry. Flip state is untouched
 * -- it's an independent, uniform toggle, not tied to any one ratio. */
export function applySelectClipRect(
  selections: EditSelectionsSnapshot,
  clipRectId: string,
  targetRatio: number,
  sourceAspectRatio: number
): TransformationResult {
  const cropRect = computeMaxCoverageCropFraction(sourceAspectRatio, targetRatio);
  return { label: `Clip rectangle: ${clipRectId}`, state: { ...selections, clipRectId, cropRect, zoomEffect: null } };
}

/**
 * Commits a drag/resize made at `currentTimeSeconds` -- from either
 * CanvasPlayer's live preview or FrameStrip's active tile, both call this.
 * Three cases:
 *  1. Dragging inside an existing transition's time range reshapes
 *     whichever endpoint (start or end) the playhead is nearer to, rather
 *     than creating a redundant second effect.
 *  2. Dragging outside any transition, with a base crop already set,
 *     creates a new one spanning a default window ending at this moment
 *     -- "the transition spreads to neighbouring frames."
 *  3. No base crop yet (the very first placement) just sets it directly.
 */
export function applyCropRectCommit(
  selections: EditSelectionsSnapshot,
  currentTimeSeconds: number,
  nextRect: CropRect
): TransformationResult {
  const { zoomEffect } = selections;
  const isEditingWithinTransition =
    zoomEffect !== null &&
    currentTimeSeconds >= zoomEffect.startTimeSeconds &&
    currentTimeSeconds <= zoomEffect.endTimeSeconds;

  if (zoomEffect && isEditingWithinTransition) {
    const distanceToStart = currentTimeSeconds - zoomEffect.startTimeSeconds;
    const distanceToEnd = zoomEffect.endTimeSeconds - currentTimeSeconds;
    const nextZoomEffect =
      distanceToStart <= distanceToEnd ? { ...zoomEffect, startRect: nextRect } : { ...zoomEffect, endRect: nextRect };
    return { label: "Adjusted transition", state: { ...selections, zoomEffect: nextZoomEffect } };
  }

  if (!selections.cropRect) {
    return { label: "Placed clip rectangle", state: { ...selections, cropRect: nextRect } };
  }

  const endTimeSeconds = currentTimeSeconds;
  const startTimeSeconds = Math.max(0, endTimeSeconds - DEFAULT_ZOOM_DURATION_SECONDS);
  return {
    label: "New transition",
    state: {
      ...selections,
      zoomEffect: { startTimeSeconds, endTimeSeconds, startRect: selections.cropRect, endRect: nextRect },
    },
  };
}

/** Toggles a flip axis from CropRectOverlay's edge handles -- "Flip"
 * (horizontal, left/right edges) or "Mirror" (vertical, top/bottom edges).
 * Applied uniformly to the whole clip, not time-varying like zoomEffect. */
export function applyFlipToggle(
  selections: EditSelectionsSnapshot,
  axis: "horizontal" | "vertical"
): TransformationResult {
  if (axis === "horizontal") {
    return { label: "Flip", state: { ...selections, flipHorizontal: !selections.flipHorizontal } };
  }
  return { label: "Mirror", state: { ...selections, flipVertical: !selections.flipVertical } };
}

/** Prolonging/shortening a transition by dragging ZoomEffectRow's edges --
 * only the time range changes, start/end rects are untouched. */
export function applyZoomRangeChange(
  selections: EditSelectionsSnapshot,
  startTimeSeconds: number,
  endTimeSeconds: number
): TransformationResult {
  const zoomEffect = selections.zoomEffect;
  if (!zoomEffect) return { label: "Adjusted transition range", state: selections };
  return {
    label: "Adjusted transition range",
    state: { ...selections, zoomEffect: { ...zoomEffect, startTimeSeconds, endTimeSeconds } },
  };
}
