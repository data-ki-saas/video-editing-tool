/**
 * Pure numeric helpers for the client-side video editor.
 *
 * Nothing in this file touches the DOM, <canvas>, <video>, or Web Audio --
 * see video.ts for frame capture and audio.ts for audio decoding, both of
 * which call into these functions for their actual number-crunching. Keeping
 * this module pure means it's trivially unit-testable and safe to reuse from
 * anywhere (main thread, a future Worker, tests) without dragging in DOM
 * dependencies.
 */
import type { FilterPresetId } from "./filterPresets";
import { CUT_TRANSITION_DURATION_SECONDS, type CutTransitionId } from "./cutTransitionPresets";
import type { CanvasFillMode } from "./canvasFillPresets";
import type { AmbientEffectId } from "./ambientEffects";

/**
 * Timestamps (seconds) to sample a clip of the given duration at a fixed
 * interval, e.g. generateSampleTimestamps(3.4, 1) -> [0, 1, 2, 3, 3.4].
 * Always includes a final sample at the clip's actual end (even if that
 * makes the last gap shorter than `intervalSeconds`), so a thumbnail strip
 * never appears to stop short of the video's real length.
 */
export function generateSampleTimestamps(durationSeconds: number, intervalSeconds: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || intervalSeconds <= 0) return [];

  const timestamps: number[] = [];
  for (let t = 0; t < durationSeconds; t += intervalSeconds) {
    timestamps.push(t);
  }

  const lastTimestamp = timestamps.at(-1);
  const EPSILON_SECONDS = 0.05; // avoids a near-duplicate final sample when duration lands exactly on a step
  if (lastTimestamp === undefined || durationSeconds - lastTimestamp > EPSILON_SECONDS) {
    timestamps.push(durationSeconds);
  }
  return timestamps;
}

// Bounds for the CanvasPlayer's preview frame rate (see
// components/editor-v2/CanvasPlayer.tsx) -- tunable in one place. Never goes
// below MIN: a clip playing back slower than 5fps stops reading as
// "playback" at all. MAX caps how smooth a *short* clip's preview gets,
// since smoother just means more frames to extract/hold in memory for no
// visible benefit past a point.
export const MIN_PREVIEW_FRAME_RATE_FPS = 5;
export const MAX_PREVIEW_FRAME_RATE_FPS = 15;
// Target ceiling on total extracted frames regardless of clip length -- a
// 3-minute clip and a 10-second clip should cost roughly the same to
// extract/hold in memory, not scale linearly with duration.
export const TARGET_PREVIEW_FRAME_BUDGET = 1800;

/** Rough, browser-exposed proxy for how much decode/compositing headroom a
 * device has -- there's no standard "current CPU/memory load" API on the
 * web, so logical core count is the closest broadly-supported signal.
 * Callers pass navigator.hardwareConcurrency in; kept as a plain parameter
 * (rather than read here) so this file stays DOM/navigator-free. */
function hardwareFpsCeiling(hardwareConcurrency: number): number {
  if (hardwareConcurrency <= 2) return MIN_PREVIEW_FRAME_RATE_FPS;
  if (hardwareConcurrency <= 4) return 10;
  return MAX_PREVIEW_FRAME_RATE_FPS;
}

/**
 * Picks a preview frame rate for extractPreviewFrames/CanvasPlayer, adapting
 * to both the clip's length (so total frame count -- and extraction time +
 * memory -- stays roughly bounded by TARGET_PREVIEW_FRAME_BUDGET rather than
 * growing linearly with duration) and the device's apparent capability.
 * Always within [MIN_PREVIEW_FRAME_RATE_FPS, MAX_PREVIEW_FRAME_RATE_FPS].
 */
export function pickPreviewFrameRate(durationSeconds: number, hardwareConcurrency: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return MAX_PREVIEW_FRAME_RATE_FPS;

  const budgetLimitedFps = TARGET_PREVIEW_FRAME_BUDGET / durationSeconds;
  const fps = Math.min(budgetLimitedFps, hardwareFpsCeiling(hardwareConcurrency), MAX_PREVIEW_FRAME_RATE_FPS);
  return Math.max(MIN_PREVIEW_FRAME_RATE_FPS, Math.round(fps));
}

/**
 * Given how much of the clip has played (in seconds), which extracted
 * preview frame should be shown right now -- pure clock math, no DOM/Web
 * Audio access, so CanvasPlayer's requestAnimationFrame loop can call this
 * every tick without it ever touching the original video or audio context.
 */
export function frameIndexAtTime(elapsedSeconds: number, frameRate: number, frameCount: number): number {
  if (frameCount <= 0) return 0;
  const index = Math.floor(elapsedSeconds * frameRate);
  return Math.min(Math.max(index, 0), frameCount - 1);
}

/** Snaps `value` to whichever of `snapPointsSeconds` is closest, if any is
 * within `thresholdSeconds` -- otherwise returns `value` unchanged. Used
 * for magnetic snapping while dragging a timeline block (see
 * VideoOverlayTrack.tsx), matching how every real NLE timeline snaps drags
 * to nearby clip boundaries, effect edges, and the playhead. */
export function snapToNearest(value: number, snapPointsSeconds: number[], thresholdSeconds: number): number {
  let closest = value;
  let closestDistance = thresholdSeconds;
  for (const point of snapPointsSeconds) {
    const distance = Math.abs(point - value);
    if (distance <= closestDistance) {
      closest = point;
      closestDistance = distance;
    }
  }
  return closest;
}

// All CropRect fields are FRACTIONS (0..1) of the frame's width/height --
// resolution-independent, so the same rect applies unchanged to the live
// canvas, every thumbnail, and any future re-extraction at a different
// preview size, with no pixel-dimension bookkeeping required at the call
// site (see CropRectOverlay.tsx, which renders these as plain percentages).
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The identity crop -- the whole frame, uncropped. Used as the fallback
// wherever a CropRect is needed but no clip rectangle has been chosen yet.
export const FULL_FRAME_CROP_RECT: CropRect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * The largest `targetRatio` (width/height) rectangle that fits centered
 * inside a `sourceWidth` x `sourceHeight` frame -- i.e. the crop that
 * maximizes coverage of the source for that target ratio, not an arbitrary
 * fixed-size center-crop. Used as the default clip rectangle whenever a new
 * ratio is picked ("the initial clip rectangle maximizes the coverage of
 * the video" per spec). Returns pixel-scale values in whatever units
 * sourceWidth/sourceHeight were given in -- see
 * computeMaxCoverageCropFraction below for the normalized (0..1) version
 * actually used/persisted by the editor.
 */
export function computeMaxCoverageCropRect(sourceWidth: number, sourceHeight: number, targetRatio: number): CropRect {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetRatio <= 0) {
    return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  }

  const sourceRatio = sourceWidth / sourceHeight;
  let width: number;
  let height: number;
  if (targetRatio > sourceRatio) {
    // Target is relatively wider than the source -- width is the
    // constraining dimension, height shrinks to hit the target ratio.
    width = sourceWidth;
    height = width / targetRatio;
  } else {
    height = sourceHeight;
    width = height * targetRatio;
  }
  return { x: (sourceWidth - width) / 2, y: (sourceHeight - height) / 2, width, height };
}

/**
 * Same as computeMaxCoverageCropRect above, but normalized to fractions
 * (0..1) of the frame -- the actual form CropRect is stored/persisted in
 * (see Timeline.editHistory in lib/projects.ts). `sourceAspectRatio` is
 * just width/height; computed by reusing the pixel-based algorithm against
 * a 1-unit-tall stand-in frame, then dividing back down to fractions.
 */
export function computeMaxCoverageCropFraction(sourceAspectRatio: number, targetRatio: number): CropRect {
  const rect = computeMaxCoverageCropRect(sourceAspectRatio, 1, targetRatio);
  return { x: rect.x / sourceAspectRatio, y: rect.y, width: rect.width / sourceAspectRatio, height: rect.height };
}

/**
 * The destination rect (fractions of the CANVAS) that shows a source frame
 * of `sourceAspectRatio` in full, letterboxed/pillarboxed to fit inside a
 * `canvasAspectRatio` frame with no cropping -- the inverse problem to
 * computeMaxCoverageCropFraction above (which crops the SOURCE to fill the
 * canvas; this instead shrinks the DESTINATION box to fit the source in
 * full, centered). Only used by a clip whose own canvasFillMode isn't "crop"
 * (see canvasFillPresets.ts) -- letterboxed empty space is filled by a
 * blurred cover-fit duplicate, a solid color, or a gradient rather than left
 * black. Only meaningful for the two canvas-based draw paths (CanvasPlayer,
 * lib/localRender/exportTimeline.ts): compileCreatomateTimeline.ts never
 * calls this -- Creatomate's own `fit: "contain"` does the identical math
 * natively.
 */
export function computeContainFitRect(sourceAspectRatio: number, canvasAspectRatio: number): CropRect {
  if (!(sourceAspectRatio > 0) || !(canvasAspectRatio > 0)) return FULL_FRAME_CROP_RECT;
  if (sourceAspectRatio > canvasAspectRatio) {
    // Source relatively wider than the canvas -- full width, letterboxed top/bottom.
    const height = canvasAspectRatio / sourceAspectRatio;
    return { x: 0, y: (1 - height) / 2, width: 1, height };
  }
  // Source relatively taller/narrower than the canvas -- full height, pillarboxed left/right.
  const width = sourceAspectRatio / canvasAspectRatio;
  return { x: (1 - width) / 2, y: 0, width, height: 1 };
}

/**
 * Re-projects a CropRect authored against ONE source aspect ratio onto a
 * DIFFERENT source aspect ratio, preserving the crop's own target ratio,
 * pan position, and zoom depth. `selections.cropRect` (the clip rectangle)
 * and any user-dragged pan/zoom ZoomEffect (applyCropRectCommit) are always
 * authored against the sequence's reference clip (the first one loaded --
 * see CanvasPlayer's referenceFrameSizeRef) and, before this function
 * existed, were reused verbatim against every later clip regardless of its
 * own real aspect ratio -- fine when every clip happens to share the same
 * shape, but for a later clip with a genuinely different one (e.g. a 16:9
 * GoPro clip spliced after 9:16 phone footage), multiplying that same
 * fraction rect by the new clip's own pixel dimensions produces a sampled
 * region whose OWN aspect ratio no longer matches the output frame's,
 * which then gets non-uniformly stretched to fill it instead of cleanly
 * cropped.
 *
 * Fixes this by decomposing the rect into the same panX/panY/zoom terms
 * OverlayFraming already uses for video-overlay footage
 * (computeCoverFitSourceRect) -- recovering "where the user panned to" and
 * "how far they zoomed in", independent of any particular aspect ratio --
 * then re-applying those same terms against the new aspect ratio.
 *
 * Callers must NOT call this at all when there's no real authored crop to
 * begin with (`selections.cropRect`/baseCropRect is null -- no clip
 * rectangle ratio was ever chosen) -- in that case every clip should show
 * its own full, native frame untouched, and FULL_FRAME_CROP_RECT ({x:0,
 * y:0, width:1, height:1}) already means exactly that regardless of aspect
 * ratio. Reprojecting it here anyway would be wrong: this function has no
 * way to tell "a rect that happens to equal full-frame because the CHOSEN
 * target ratio matches the reference clip's own shape" (which DOES need
 * reprojecting onto a later, differently-shaped clip) apart from "full
 * frame because no ratio was ever chosen at all" (which must stay full
 * frame for every clip) -- both arrive here as the identical {0,0,1,1}
 * value, so the two cases can only be told apart by whichever caller still
 * has `baseCropRect`'s original null-ness in scope.
 *
 * Also NOT for a per-clip rect that's already self-scoped to its own clip
 * (an image sequence entry's own Ken Burns ZoomEffect, built from that
 * image's own cropRect via buildKenBurnsEffect/imageTemplates.ts) --
 * reprojecting one of those FROM the reference aspect ratio would be
 * wrong, since it was never authored in that space to begin with. Callers
 * key off SequenceEntry.kind for this: reproject for "video", pass through
 * unchanged for "image".
 */
export function reprojectCropRect(crop: CropRect, fromAspectRatio: number, toAspectRatio: number): CropRect {
  if (!(fromAspectRatio > 0) || !(toAspectRatio > 0) || Math.abs(fromAspectRatio - toAspectRatio) < 1e-9) {
    return crop;
  }

  // Recover this rect's own target ratio and, via the same cover-fit
  // geometry computeCoverFitSourceRect uses, its panX/panY/zoom against the
  // frame it was authored for (sourceHeight pinned to 1 -- see
  // computeMaxCoverageCropFraction's identical normalized-frame convention).
  const targetRatio = (crop.width * fromAspectRatio) / crop.height;
  const sWidth = crop.width * fromAspectRatio;
  const sHeight = crop.height;
  const coverHeight = fromAspectRatio > targetRatio ? 1 : fromAspectRatio / targetRatio;
  const zoom = coverHeight / sHeight;
  const xSlack = fromAspectRatio - sWidth;
  const ySlack = 1 - sHeight;
  const panX = xSlack > 1e-9 ? (crop.x * fromAspectRatio) / xSlack : 0.5;
  const panY = ySlack > 1e-9 ? crop.y / ySlack : 0.5;

  // Re-apply the same target ratio + pan/zoom against the new aspect ratio.
  const projected = computeCoverFitSourceRect(toAspectRatio, 1, targetRatio, 1, panX, panY, zoom);
  return { x: projected.sx / toAspectRatio, y: projected.sy, width: projected.sWidth / toAspectRatio, height: projected.sHeight };
}

/**
 * Eases a linear progress value 0..1 into an ease-in-out curve (slow ->
 * fast -> slow) -- applied before interpolating a transition's rect so a
 * zoom/pan accelerates into and decelerates out of the move instead of
 * changing at constant speed, which reads as mechanical rather than
 * smooth. Standard cubic ease-in-out; kept as its own named function
 * (rather than inlined into interpolateCropRect) so a different curve can
 * be swapped in later without touching the interpolation math itself.
 */
export function easeInOut(t: number): number {
  const clampedT = Math.min(Math.max(t, 0), 1);
  return clampedT < 0.5 ? 4 * clampedT ** 3 : 1 - (-2 * clampedT + 2) ** 3 / 2;
}

/**
 * Interpolates between two CropRects (both fractions, see above) at
 * progress `t` (0 = start, 1 = end, clamped and eased via easeInOut above)
 * -- the "algorithm calculates the sizes and position of intermediate
 * clip rectangles" driving a zoom/pan transition's live preview (see
 * ZoomEffectRow.tsx and CanvasPlayer's effective-crop-rect-at-time logic).
 * Lerp on each field independently -- width/height move at the same rate
 * as x/y so the rect visually scales and moves together, not in two
 * separate motions.
 */
export function interpolateCropRect(start: CropRect, end: CropRect, t: number): CropRect {
  const easedT = easeInOut(t);
  return {
    x: start.x + (end.x - start.x) * easedT,
    y: start.y + (end.y - start.y) * easedT,
    width: start.width + (end.width - start.width) * easedT,
    height: start.height + (end.height - start.height) * easedT,
  };
}

/**
 * Scales a CropRect by `scale` around its own center -- e.g. scale=0.65
 * shrinks it to 65% of its size while keeping the same midpoint, which is
 * exactly "resizing the clip rectangle in the same aspect ratio" that a
 * zoom in/out's start or end rect needs (scale preserves width/height's
 * ratio automatically, since both shrink/grow by the same factor).
 */
export function scaleCropRectCentered(rect: CropRect, scale: number): CropRect {
  const width = rect.width * scale;
  const height = rect.height * scale;
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}

/**
 * A zoom/pan transition as three keyframes, not two: `startRect` (normal,
 * at startTimeSeconds), `epicenterRect` (the peak -- max zoom-in, or the
 * furthest point of a pan -- at epicenterTimeSeconds), and `endRect` (at
 * endTimeSeconds, defaulting to startRect so the transition eases back to
 * normal by default -- "I zoom in, then slowly zoom out back to normal").
 * The two halves (start->epicenter, epicenter->start) each get their own
 * ease-in-out via interpolateCropRect, which reads as a natural
 * accelerate-into/hold-at/decelerate-out-of the peak rather than one
 * mechanical A-to-B move. Dragging the epicenter's own green dot on
 * ZoomEffectsTrack only moves epicenterTimeSeconds, independent of the
 * overall start/end range; stretching the segment's edges only moves
 * start/endTimeSeconds, independent of the epicenter's own position --
 * see transformations.ts's applyZoomEpicenterChange vs applyZoomRangeChange.
 */
export interface ZoomEffect {
  startTimeSeconds: number;
  epicenterTimeSeconds: number;
  endTimeSeconds: number;
  startRect: CropRect;
  epicenterRect: CropRect;
  endRect: CropRect;
}

/**
 * Which of several ZoomEffects (if any) is in effect at `timeSeconds` --
 * strictly between its own start/end, never at the boundary itself.
 * ZoomEffects are mutually exclusive with each other (both zoom and pan
 * are just rect-to-rect transitions of the same type, so two can never
 * overlap in time -- see transformations.ts's applyCropRectCommit, which
 * clamps a newly-created one against whatever's already there); a
 * DIFFERENT effect type added later (its own array, its own row below the
 * timeline) would get its own version of this same lookup rather than
 * sharing this one.
 */
export function findActiveZoomEffectIndex(zoomEffects: ZoomEffect[], timeSeconds: number): number {
  return zoomEffects.findIndex((effect) => timeSeconds > effect.startTimeSeconds && timeSeconds < effect.endTimeSeconds);
}

/**
 * The crop rect that should actually be shown at `timeSeconds`, given the
 * clip rectangle -- the clip's fixed, ongoing property -- and whichever
 * zoom/pan effect (if any) is active at that instant. A zoom/pan is a
 * LOCALIZED, temporary deviation, only ever in effect strictly between its
 * own start/end times (the range shown by ZoomEffectsTrack below the
 * timeline): outside that range, on either side, the fixed clip rectangle
 * applies -- it does not persist the effect's end state past where the
 * effect actually ends.
 *
 * Inside the range, interpolates through whichever HALF of the effect
 * `timeSeconds` falls in -- start->epicenter, or epicenter->end -- each
 * its own eased lerp, so the rect eases into the epicenter and eases back
 * out of it rather than moving through it at constant speed.
 */
export function computeEffectiveCropRect(
  baseCropRect: CropRect,
  zoomEffects: ZoomEffect[],
  timeSeconds: number
): CropRect {
  const activeIndex = findActiveZoomEffectIndex(zoomEffects, timeSeconds);
  if (activeIndex === -1) return baseCropRect;

  const zoomEffect = zoomEffects[activeIndex];
  if (timeSeconds <= zoomEffect.epicenterTimeSeconds) {
    const duration = zoomEffect.epicenterTimeSeconds - zoomEffect.startTimeSeconds;
    const t = duration > 0 ? (timeSeconds - zoomEffect.startTimeSeconds) / duration : 1;
    return interpolateCropRect(zoomEffect.startRect, zoomEffect.epicenterRect, t);
  }
  const duration = zoomEffect.endTimeSeconds - zoomEffect.epicenterTimeSeconds;
  const t = duration > 0 ? (timeSeconds - zoomEffect.epicenterTimeSeconds) / duration : 1;
  return interpolateCropRect(zoomEffect.epicenterRect, zoomEffect.endRect, t);
}

// Toggle points within this distance (seconds) of an existing one collapse
// into it (removing it) instead of adding a redundant second one right next
// to it -- lets "click flip again at the same frame" cleanly undo the
// toggle just placed there rather than leaving two adjacent no-op toggles.
const FLIP_TOGGLE_EPSILON_SECONDS = 0.05;

/**
 * Inserts a flip toggle at `timeSeconds` into a sorted list of toggle
 * timestamps -- or removes one already sitting within
 * FLIP_TOGGLE_EPSILON_SECONDS of it. A flip axis starts OFF at time 0;
 * each toggle in the (sorted) list flips it, so an odd number of toggles
 * at-or-before a given time means it's ON then (see computeEffectiveFlip
 * below). "Flip starts from the frame I clicked, and clicking a later
 * frame flips it back" is exactly this insert -- no explicit end time is
 * ever needed, since the NEXT toggle (or the clip's end, if there isn't
 * one) defines where this one's window stops.
 */
export function toggleFlipAt(toggles: number[], timeSeconds: number): number[] {
  const existingIndex = toggles.findIndex((t) => Math.abs(t - timeSeconds) < FLIP_TOGGLE_EPSILON_SECONDS);
  if (existingIndex !== -1) {
    return toggles.filter((_, index) => index !== existingIndex);
  }
  return [...toggles, timeSeconds].sort((a, b) => a - b);
}

/**
 * Whether a flip axis is engaged at `timeSeconds`, given its sorted list of
 * toggle timestamps -- ON exactly when an odd number of toggles fall
 * at-or-before this instant. Unlike a zoom/pan ZoomEffect, this is a plain
 * step function, never eased -- there's no meaningful "half-flipped" frame
 * to interpolate toward.
 */
export function computeEffectiveFlip(toggles: number[], timeSeconds: number): boolean {
  const toggleCount = toggles.filter((t) => t <= timeSeconds).length;
  return toggleCount % 2 === 1;
}

/** One contiguous "flipped" time range -- for FlipTrack's readout below the
 * timeline, see computeFlipSegments. */
export interface FlipSegment {
  startTimeSeconds: number;
  endTimeSeconds: number;
}

/**
 * Every contiguous ON window implied by a sorted toggle list -- pairs
 * consecutive toggles into (start, end), with an unpaired final toggle's
 * window running to the end of the clip (an odd toggle count means the
 * flip is still engaged when the clip ends).
 */
export function computeFlipSegments(toggles: number[], durationSeconds: number): FlipSegment[] {
  if (toggles.length === 0) return [];
  const sorted = [...toggles].sort((a, b) => a - b);
  const segments: FlipSegment[] = [];
  for (let i = 0; i < sorted.length; i += 2) {
    const startTimeSeconds = sorted[i];
    const endTimeSeconds = i + 1 < sorted.length ? sorted[i + 1] : durationSeconds;
    segments.push({ startTimeSeconds, endTimeSeconds });
  }
  return segments;
}

/** A cut-out stretch of the clip -- see components/editor-v2/TrimTrack.tsx
 * for the click-to-place-then-click-to-close gesture that creates one, and
 * CanvasPlayer's skipTrimmedRanges for how it's actually skipped during
 * playback rather than just marked. */
export interface TrimRange {
  startTimeSeconds: number;
  endTimeSeconds: number;
}

/**
 * Folds a fresh (or just-edited) trim range into a sorted, non-overlapping
 * list -- any ranges that now overlap or touch collapse into one wider
 * range (min start, max end). Two trims a user places without lining up
 * their edges exactly still end up as one clean cut rather than two
 * fragments needing to be reconciled by hand.
 */
export function mergeTrimRanges(ranges: TrimRange[]): TrimRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.startTimeSeconds - b.startTimeSeconds);
  const merged: TrimRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.startTimeSeconds <= last.endTimeSeconds) {
      last.endTimeSeconds = Math.max(last.endTimeSeconds, current.endTimeSeconds);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
}

/** Which trim range (if any) has cut out `timeSeconds` -- inclusive of its
 * start, exclusive of its end, so landing exactly on a range's end counts
 * as just past the cut, not still inside it. */
export function findTrimRangeIndexAt(trimRanges: TrimRange[], timeSeconds: number): number {
  return trimRanges.findIndex((range) => timeSeconds >= range.startTimeSeconds && timeSeconds < range.endTimeSeconds);
}

/**
 * If `timeSeconds` has been cut out, the next moment that hasn't been --
 * that range's own end, walked forward again in case that lands inside
 * ANOTHER range too (ranges are merged so this can only happen with two
 * ranges placed back-to-back). Otherwise `timeSeconds` unchanged. This is
 * the actual "deletion" -- CanvasPlayer calls it on every playback tick and
 * on every seek, so a cut section is genuinely skipped over, not merely
 * marked.
 */
export function skipTrimmedRanges(trimRanges: TrimRange[], timeSeconds: number): number {
  let time = timeSeconds;
  let rangeIndex = findTrimRangeIndexAt(trimRanges, time);
  while (rangeIndex !== -1) {
    time = trimRanges[rangeIndex].endTimeSeconds;
    rangeIndex = findTrimRangeIndexAt(trimRanges, time);
  }
  return time;
}

/**
 * @deprecated superseded by ImageOverlayClip (below), which gives images
 * the same switchable Full-Screen/Picture-in-Picture/Split-Screen layout
 * video overlays already have, instead of always being a fixed
 * picture-in-picture-shaped rect. Kept only so a project's persisted
 * history entries from before that change still type-check -- see
 * ThreePaneEditor.tsx's own migration `useMemo` (next to its videoOverlays
 * one) for how a legacy entry here is upgraded into an ImageOverlayClip at
 * load time. Never written by new code.
 */
export interface OverlayImage {
  assetId: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  rect: CropRect;
}

/**
 * Every overlay visible at `timeSeconds` -- unlike a ZoomEffect, more than
 * one overlay CAN be visible at once (different images, or the same image
 * placed twice), so this returns a list rather than a single index. Half-
 * open (inclusive start, exclusive end), same convention as trim ranges.
 */
export function findActiveOverlays(overlays: OverlayImage[], timeSeconds: number): OverlayImage[] {
  return overlays.filter((overlay) => timeSeconds >= overlay.startTimeSeconds && timeSeconds < overlay.endTimeSeconds);
}

/**
 * A second video asset, placed on its own timeline rail for a time window,
 * with a LAYOUT the user can switch afterward (see VideoOverlayTrack.tsx's
 * right-click menu and transformations.ts's applyChangeVideoOverlayLayout)
 * without re-placing, re-trimming, or losing the chosen source clip:
 *  - "full-screen": the overlay's footage fully replaces the base clip's
 *    picture for the window (a classic "cut away to other footage, then
 *    cut back" edit -- the base clip's own audio/timeline keep running
 *    underneath, only the picture is swapped).
 *  - "picture-in-picture": a small movable/resizable box on top of the
 *    base clip, which stays fully visible underneath (see FrameStrip.tsx's
 *    tile-level OverlayRectOverlay -- reused here exactly as image overlays
 *    already use it, including drag-to-move/resize).
 *  - "split-screen": the frame divides in two, base clip in one half,
 *    overlay footage in the other -- `orientation` picks side-by-side vs
 *    top-and-bottom, `partnerFirst` picks which half the overlay occupies.
 *
 * Full-Screen and Split-Screen are mutually exclusive with EACH OTHER (and
 * with each other's own kind) in time -- both claim "what defines the base
 * picture" for their window, so two can't apply at once (see
 * isExclusiveLayout below). Picture-in-Picture never claims exclusivity --
 * it floats on top of whatever's showing, so any number of PIP clips can
 * coexist/overlap, including overlapping a Full-Screen/Split-Screen window.
 *
 * Named "VideoOverlayClip"/"VideoOverlayLayout" (not "OverlayClip") to avoid
 * colliding with the pre-existing, unrelated OverlayImage type above.
 */
export type VideoOverlayLayout =
  | { type: "full-screen" }
  | { type: "picture-in-picture"; rect: CropRect } // width/height locked at creation; only x/y move by default, though the reused OverlayRectOverlay drag handle also lets a user resize it
  // baseFraming lives HERE (not on VideoOverlayClip itself) because it's
  // only ever meaningful for Split-Screen -- Full-Screen hides the base
  // entirely (nothing to frame) and Picture-in-Picture never reshapes it
  // (it stays full-frame underneath, needing no separate crop of its own).
  // Independent of the OVERLAY's own `framing` (VideoOverlayClip.framing
  // below) -- each half gets its own pan/flip. `ratio` is the fraction of
  // the frame given to the LEADING slot (left, or top -- see
  // computeOverlayRects below; `partnerFirst` decides which of base/overlay
  // actually occupies that slot, independent of the ratio itself), dragged
  // via VideoOverlayFramingDialog's own divider -- 0.5 (an even split) is
  // the default every overlay is created with.
  | { type: "split-screen"; orientation: "horizontal" | "vertical"; partnerFirst: boolean; baseFraming: OverlayFraming; ratio: number };

export function isExclusiveLayout(layout: VideoOverlayLayout): boolean {
  return layout.type !== "picture-in-picture";
}

/**
 * How the overlay's OWN footage is framed within whatever box its layout
 * gives it -- independent of the layout choice itself (switching layout
 * keeps these), adjusted via VideoOverlayTrack's own framing button (a
 * popup showing the overlay's source frame; click/drag to recenter, plus
 * flip toggles -- see VideoOverlayFramingDialog.tsx). Every layout that
 * crops the overlay's footage into a differently-shaped box than its own
 * (Full-Screen, Split-Screen, and a Picture-in-Picture box whose aspect
 * doesn't match the source) does so via a "cover" fit
 * (computeCoverFitSourceRect below) -- `panX`/`panY` choose WHICH part of
 * the source survives that crop, instead of always dead-centering it.
 * Fractions (0..1) of the SOURCE frame.
 */
export interface OverlayFraming {
  panX: number;
  panY: number;
  // How far to crop in past the natural "cover" fit (1 = exactly cover,
  // matching every framing persisted before this field existed). Adjusted
  // via VideoOverlayFramingDialog's own Zoom slider; panX/panY still choose
  // WHERE within the zoomed-in window sits, over a correspondingly smaller
  // range of slack -- see computeCoverFitSourceRect below for how the two
  // combine.
  //
  // Below 1 ("zoom out") is only meaningful for a Picture-in-Picture box --
  // Full-Screen/Split-Screen have nothing behind them to reveal, so every
  // OTHER render call site still floors this at 1 via
  // computeCoverFitSourceRect's own default `minZoom` (a stray <1 value
  // left over from a since-switched-away-from PiP layout -- see
  // VideoOverlayLayout's own doc comment on framing surviving a layout
  // switch -- is therefore automatically inert the moment it's not PiP
  // anymore, with no separate migration needed). Only the PiP draw/render
  // call sites (CanvasPlayer.tsx, exportTimeline.ts) pass the lower
  // MIN_PICTURE_IN_PICTURE_ZOOM floor, and only the Zoom slider's own `min`
  // in VideoOverlayFramingDialog/ImageOverlayFramingDialog relaxes to match
  // when editing a PiP overlay.
  zoom: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

export const DEFAULT_OVERLAY_FRAMING: OverlayFraming = { panX: 0.5, panY: 0.5, zoom: 1, flipHorizontal: false, flipVertical: false };

// How far a Picture-in-Picture overlay's own footage is allowed to "zoom
// out" past its natural cover fit -- see OverlayFraming.zoom's doc comment
// above for why this floor only ever applies to PiP. 0.3 comfortably
// reveals the full source (letterboxed within the box, the box's OWN
// backdrop showing through the gap -- see computeCoverFitSourceRect's own
// doc comment on how going past "fully revealed" then just shrinks the
// visible footage further) for every aspect-ratio mismatch this app's
// output ratios + source footage realistically produce, without the
// footage shrinking to an unusably tiny speck.
export const MIN_PICTURE_IN_PICTURE_ZOOM = 0.3;

// An even split -- what every Split-Screen overlay starts with, and what a
// pre-`ratio` persisted layout (see the `?? DEFAULT_SPLIT_SCREEN_RATIO`
// fallback in computeOverlayRects below) is treated as having meant all
// along, since that's exactly what the old, un-adjustable 50/50 split was.
export const DEFAULT_SPLIT_SCREEN_RATIO = 0.5;

// Shortest a video overlay is ever allowed to be, on-timeline OR
// source-side -- shared by VideoOverlayTrack.tsx's edge-drag clamp and
// transformations.ts's applyChangeVideoOverlaySourceStart, so the two can
// never disagree about how much room a source-start move must leave for a
// later end-edge drag to still find a valid range.
export const MIN_VIDEO_OVERLAY_DURATION_SECONDS = 0.2;

/** Shared shape for a background-removal job, carried on VideoOverlayClip
 * and both SequenceEntry variants (video/image) below, and mirrored on
 * CutawayTrack.tsx's own CutawaySegment view-model. `progress` is a
 * transient, ESTIMATED 0..1 fraction of how far along the job is (see
 * lib/backgroundRemoval.ts's own comment on why this can only ever be an
 * estimate -- fal.ai's VEED integration is webhook-only, with no interim
 * status the provider actually reports) -- never persisted, only ever
 * spliced in for display by ThreePaneEditor while a job is in flight, same
 * reason it's optional here as `matteAssetId` (absent once the job resolves
 * one way or the other). Neither field is ever meaningful for "chromaKey"
 * mode -- see that mode's own doc below.
 *
 * `mode` distinguishes two removal STRATEGIES, currently only meaningful for
 * a VideoOverlayClip (SequenceEntry's video/image kinds only ever use "ai"):
 * absent/"ai" is the original fal.ai/VEED (or rembg, for a photo) AI matting
 * job -- requested right away, `matteAssetId`/`progress` populated once it
 * resolves. "chromaKey" is a solid-color (green/blue screen) cutout, keyed
 * out entirely client-side (lib/video/chromaKey.ts) -- for BOTH live preview
 * (chromaKeyFramesToAlphaMasks, against pre-extracted preview frames) AND
 * Edge Render's actual output (applyChromaKeyAlpha, against real seeked
 * export frames in lib/localRender/exportTimeline.ts) -- by design, never
 * requests a fal.ai job at all, at add-time OR render-time, so
 * `matteAssetId`/`progress` stay permanently absent/null for this mode. */
export type BackgroundRemovalMode = "ai" | "chromaKey";
export type BackgroundRemovalState = {
  enabled: boolean;
  matteAssetId?: string | null;
  progress?: number;
  mode?: BackgroundRemovalMode;
  // Only meaningful when mode === "chromaKey" -- a hex color, see
  // lib/video/chromaKey.ts's CHROMA_KEY_PRESETS.
  chromaKeyColor?: string;
};

export interface VideoOverlayClip {
  assetId: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  // This overlay's own color filter, independent of every other cutaway/
  // overlay's choice -- see lib/video/filterPresets.ts's FILTER_PRESET_OPTIONS.
  // Null/undefined means unfiltered ("Original").
  colorFilterId?: FilterPresetId | null;
  // Offset INTO the source asset's own footage where playback starts --
  // set via VideoOverlayTrack.tsx's flag icon (OverlaySourceStartDialog),
  // which also hard-clamps how far the overlay's own end edge can be
  // dragged to `sourceDurationSeconds - sourceStartSeconds` (one
  // play-through from this in-point, no further).
  sourceStartSeconds: number;
  layout: VideoOverlayLayout;
  framing: OverlayFraming;
  // 0 = only the base clip's own audio plays through this window (the
  // original behavior, and the default -- preserves every overlay added
  // before this field existed); 1 = only the overlay's own audio;
  // in between mixes both, each at that fraction of its own natural
  // volume (0.5 = both at half, not both at full -- avoids a jarring
  // double-loud mix, same reasoning a constant-power audio crossfade
  // uses). Adjusted via VideoOverlayTrack.tsx's own per-segment volume
  // badge/popup -- see CanvasPlayer.tsx for how this is actually scheduled
  // as gain automation during playback.
  audioBalance: number;
  // Same AI background removal as SequenceEntry's "video" variant (see its
  // own doc comment) -- keys out this overlay's own footage (e.g. a
  // green-screen talking-head clip) so the Ken Burns/base track beneath it
  // shows through instead of a solid color. Set via
  // VideoOverlayPickerDialog.tsx's "Remove background" toggle;
  // ThreePaneEditor's requestAndPollVideoOverlayBackgroundRemoval patches
  // in the real matteAssetId once VEED's job completes, same staging as
  // the Cutaway path. Unlike SequenceEntry, only ever set at add-time --
  // there's no dialog to flip it on afterward for an already-placed overlay.
  backgroundRemoval?: BackgroundRemovalState | null;
  // Same "Make it 3D" toggle as SequenceEntry's image variant (see its own
  // doc comment) -- since an overlay has only a static `framing` (no
  // keyframed pan/zoom timeline), the dolly is synthesized as one fixed
  // subtle push over the overlay's own start->end window rather than riding
  // an existing effect -- see camera3D.ts's computeCamera3DPoseForOverlay.
  camera3D?: boolean;
  // A subtle looping overlay (light sweep / sparkle / leaves, see
  // ambientEffects.ts) drawn on top of whatever this overlay already
  // rendered (plain framing OR the camera3D path above) -- independent of
  // camera3D, so the two combine freely. Absent/null means none.
  ambientEffect?: AmbientEffectId | null;
}

/**
 * An image asset placed on its own rail for a time window, with the SAME
 * switchable layout system as VideoOverlayClip above (Full-Screen /
 * Picture-in-Picture / Split Screen, via the shared VideoOverlayLayout
 * union) -- deliberate parity: an image overlay behaves exactly like a
 * video overlay except it has no source footage of its own to play (no
 * `sourceStartSeconds`) and no audio to mix (no `audioBalance`). Everything
 * that reasons about "which layout is active/exclusive at this instant"
 * (isExclusiveLayout, findActiveExclusiveOverlay,
 * findActivePictureInPictureOverlays below) is shared, generic code -- both
 * clip types satisfy the same minimal shape. Replaces the old OverlayImage
 * (always a fixed picture-in-picture rect) -- see ThreePaneEditor.tsx's
 * migration useMemo for how a legacy OverlayImage becomes one of these at
 * load time (a picture-in-picture layout wrapping its old `rect`).
 */
export interface ImageOverlayClip {
  assetId: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  layout: VideoOverlayLayout;
  framing: OverlayFraming;
  // Same per-clip color filter as VideoOverlayClip.colorFilterId above.
  colorFilterId?: FilterPresetId | null;
  // Same "Make it 3D" toggle as VideoOverlayClip.camera3D above.
  camera3D?: boolean;
  // Same ambient overlay as VideoOverlayClip.ambientEffect above.
  ambientEffect?: AmbientEffectId | null;
}

/** Cache key for a still frame captured at one overlay placement's own
 * sourceStartSeconds -- shared between ThreePaneEditor.tsx (which populates
 * the cache) and FrameStrip.tsx (which reads it) so the two never drift on
 * how the key is built. Keyed by (assetId, sourceStartSeconds) rather than
 * overlay index/identity, since that's the only thing that actually
 * determines what the captured frame looks like -- two placements sharing
 * both values share the same frame for free. */
export function videoOverlayStartThumbnailKey(assetId: string, sourceStartSeconds: number): string {
  return `${assetId}:${sourceStartSeconds}`;
}

// The minimal shape findActiveExclusiveOverlay/findActivePictureInPictureOverlays
// need -- generic over VideoOverlayClip AND ImageOverlayClip (both satisfy
// this exactly), so one implementation serves both CanvasPlayer's video-
// overlay and image-overlay compositing passes without duplicating the
// lookup logic.
interface LayoutTimedClip {
  startTimeSeconds: number;
  endTimeSeconds: number;
  layout: VideoOverlayLayout;
}

/** The single EXCLUSIVE-layout overlay (Full-Screen or Split-Screen) active
 * at `timeSeconds`, if any -- at most one can ever be active PER ARRAY,
 * since those two layouts are mutually exclusive with each other WITHIN the
 * same clip type (video-exclusive and image-exclusive are independent --
 * see CanvasPlayer.tsx's own comment on which wins when both overlap). */
export function findActiveExclusiveOverlay<T extends LayoutTimedClip>(clips: T[], timeSeconds: number): T | null {
  return clips.find((c) => isExclusiveLayout(c.layout) && timeSeconds >= c.startTimeSeconds && timeSeconds < c.endTimeSeconds) ?? null;
}

/** Every Picture-in-Picture overlay active at `timeSeconds` -- unlike the
 * exclusive layouts, more than one CAN be visible at once. */
export function findActivePictureInPictureOverlays<T extends LayoutTimedClip>(clips: T[], timeSeconds: number): T[] {
  return clips.filter((c) => c.layout.type === "picture-in-picture" && timeSeconds >= c.startTimeSeconds && timeSeconds < c.endTimeSeconds);
}

// Short linear ramp (rather than a hard setValueAtTime step) for the main-
// track ducking and overlay-audio fade transitions below -- avoids an
// audible click/pop at a hard volume step. Shared by CanvasPlayer's live
// mixing graph and exportTimeline.ts's offline mix, so both fade at the same
// rate.
export const AUDIO_TRANSITION_RAMP_SECONDS = 0.03;

/**
 * Samples the three-way audio mix (base track / video-overlay's own audio /
 * TTS narration) at one instant -- the single formula every ducking call
 * site below is built from, so live preview, offline export, and (should it
 * ever reach the Creatomate compiler) a real render can't disagree on it.
 *
 * The mixer spec: a video overlay's `audioBalance` and a TTS overlay's
 * `volume` (both already 0..1 fractions of "full") are each the level that
 * clip plays at, UNCHANGED, as long as the two don't add up to more than 1
 * (100%) -- the base track just takes whatever's left over
 * (`1 - (balance + volume)`). Only once their sum would exceed 100% does the
 * base track drop to 0 AND the two get scaled back down together (by
 * `1 / sum`) so they fill exactly 100% instead of playing louder than that
 * combined -- their own ratio to each other is preserved, neither one is
 * silenced in favor of the other. `duckScale` is that single multiplier
 * (1 whenever nothing needs scaling back) -- both an active video overlay's
 * own gain automation and an active TTS overlay's own gain automation
 * multiply their nominal level by it at this same instant (see
 * CanvasPlayer.tsx/exportTimeline.ts's own per-clip gain scheduling).
 *
 * With no TTS overlays active, this reduces exactly to the old
 * audioBalance-only ducking (`mainGain = 1 - balance`, `duckScale` always 1,
 * since a lone 0..1 balance can never exceed 1 on its own) -- this function
 * replaces what used to be a video-overlay-only computeMainAudioGainBreakpoints.
 * Multiple simultaneously-active clips of the SAME kind (two overlapping
 * Picture-in-Picture overlays, or -- unusual, but not disallowed -- two
 * overlapping TTS overlays) use `Math.max` of their own levels, same
 * "strongest request wins, not compounded" convention as before.
 */
export function sampleAudioMixAt(
  videoOverlays: VideoOverlayClip[],
  ttsOverlays: TtsOverlay[],
  timeSeconds: number
): { mainGain: number; duckScale: number } {
  const overlayBalance = videoOverlays
    .filter((o) => o.audioBalance > 0 && timeSeconds >= o.startTimeSeconds && timeSeconds < o.endTimeSeconds)
    .reduce((max, o) => Math.max(max, o.audioBalance), 0);
  const ttsVolume = ttsOverlays
    .filter((o) => timeSeconds >= o.startTimeSeconds && timeSeconds < ttsOverlayEndTimeSeconds(o))
    .reduce((max, o) => Math.max(max, Math.min(Math.max(o.volume, 0), 1)), 0);
  const combined = overlayBalance + ttsVolume;
  return { mainGain: Math.max(0, 1 - combined), duckScale: combined > 1 ? 1 / combined : 1 };
}

/** The base clip's own audio volume (`mainGain`, 0..1) AND the shared
 * `duckScale` every active video-overlay/TTS clip's own gain multiplies by
 * (see sampleAudioMixAt above), over time, as a step function -- hard cuts
 * at each boundary (no fade), callers apply their own short ramp
 * (AUDIO_TRANSITION_RAMP_SECONDS above) around each breakpoint instead.
 * Breakpoints are returned in order, each holding until the next one. All
 * times here are in the ORIGINAL (pre-trim) sequence timeline, same as
 * VideoOverlayClip.startTimeSeconds/endTimeSeconds -- see RenderSegment's
 * own doc comment on that convention, and mapSourceRangeToOutputRanges below
 * for translating a breakpoint interval into its OUTPUT-time equivalent(s)
 * for an offline render. */
export function computeAudioMixBreakpoints(
  videoOverlays: VideoOverlayClip[],
  ttsOverlays: TtsOverlay[],
  totalDurationSeconds: number
): { timeSeconds: number; mainGain: number; duckScale: number }[] {
  const activeOverlays = videoOverlays.filter((o) => o.audioBalance > 0);
  const points = new Set<number>([0, totalDurationSeconds]);
  for (const overlay of activeOverlays) {
    if (overlay.startTimeSeconds > 0 && overlay.startTimeSeconds < totalDurationSeconds) points.add(overlay.startTimeSeconds);
    if (overlay.endTimeSeconds > 0 && overlay.endTimeSeconds < totalDurationSeconds) points.add(overlay.endTimeSeconds);
  }
  for (const overlay of ttsOverlays) {
    const endSeconds = ttsOverlayEndTimeSeconds(overlay);
    if (overlay.startTimeSeconds > 0 && overlay.startTimeSeconds < totalDurationSeconds) points.add(overlay.startTimeSeconds);
    if (endSeconds > 0 && endSeconds < totalDurationSeconds) points.add(endSeconds);
  }
  const sorted = Array.from(points).sort((a, b) => a - b);

  return sorted.map((timeSeconds, index) => {
    // Sampled just after this breakpoint (the midpoint to the next one, or
    // the point itself for the last) to decide what's active starting HERE.
    const sampleAt = index < sorted.length - 1 ? (timeSeconds + sorted[index + 1]) / 2 : timeSeconds;
    return { timeSeconds, ...sampleAudioMixAt(videoOverlays, ttsOverlays, sampleAt) };
  });
}

/**
 * The base clip's own destination rect (null when it's fully covered, i.e.
 * Full-Screen) and the overlay's own destination rect, for a given layout --
 * the ONE place this geometry is computed, shared by CanvasPlayer's
 * drawImage destination rects and compileCreatomateTimeline's element
 * positioning, so preview and render can never disagree on where a seam
 * falls or which side is which.
 *
 * `baseRect: null` for Full-Screen does NOT need special-case handling
 * anywhere that draws in back-to-front order: the overlay's own element is
 * drawn AFTER the base (CanvasPlayer) / on a later track (Creatomate), at
 * full opacity, filling the entire frame -- it already fully covers the
 * base whether or not the base was drawn underneath it. Skipping the base
 * draw for Full-Screen is a pure performance optimization, never required
 * for correctness.
 */
export function computeOverlayRects(layout: VideoOverlayLayout): { baseRect: CropRect | null; overlayRect: CropRect } {
  switch (layout.type) {
    case "full-screen":
      return { baseRect: null, overlayRect: FULL_FRAME_CROP_RECT };
    case "picture-in-picture":
      return { baseRect: FULL_FRAME_CROP_RECT, overlayRect: layout.rect };
    case "split-screen": {
      // `?? DEFAULT_SPLIT_SCREEN_RATIO`: `ratio` was added after some
      // projects already had a split-screen overlay persisted without it --
      // see CanvasPlayer.tsx's identical `baseFraming` fallback for the
      // full explanation. Absent, it means exactly what the old fixed
      // 50/50 split meant.
      const leadingSize = layout.ratio ?? DEFAULT_SPLIT_SCREEN_RATIO;
      const trailingSize = 1 - leadingSize;
      const leading: CropRect =
        layout.orientation === "horizontal" ? { x: 0, y: 0, width: leadingSize, height: 1 } : { x: 0, y: 0, width: 1, height: leadingSize };
      const trailing: CropRect =
        layout.orientation === "horizontal"
          ? { x: leadingSize, y: 0, width: trailingSize, height: 1 }
          : { x: 0, y: leadingSize, width: 1, height: trailingSize };
      return layout.partnerFirst ? { baseRect: trailing, overlayRect: leading } : { baseRect: leading, overlayRect: trailing };
    }
  }
}

/** Source-rect for a "cover" fit -- scales sourceWidth x sourceHeight up to
 * fully cover a targetWidth x targetHeight box, cropping whichever
 * dimension overflows. `panX`/`panY` (fractions 0..1 of the source,
 * default 0.5 = centered -- see OverlayFraming) choose WHERE within that
 * overflow the crop is taken from, instead of always dead-centering it --
 * only ever one of the two actually matters for a given source/target
 * ratio pair (whichever dimension is being cropped), the other is ignored
 * since that axis keeps its full extent. Mirrors Creatomate's `fit:
 * "cover"` exactly when panX/panY are left at 0.5 and zoom at 1, so the
 * live preview and the real render agree on how footage of a different
 * aspect ratio than its destination box gets cropped.
 *
 * `zoom` (default 1 -- see OverlayFraming) crops in past the natural cover
 * fit: the sampled window's size shrinks by 1/zoom on both axes (same
 * aspect ratio throughout, so it still exactly covers the target box once
 * scaled up), and panX/panY then place that smaller window within the FULL
 * source's slack, same formula as the zoom=1 case -- this is exactly why
 * zoom=1 reproduces the original behavior unchanged.
 *
 * `minZoom` (default 1, the original floor) lets a caller allow `zoom`
 * below 1 -- i.e. "zoom OUT" past cover, sampling a LARGER window than
 * cover needs. Growing sWidth/sHeight past what the caller's own
 * drawImage-style consumer then does with sx/sy/sWidth/sHeight is what
 * actually produces the zoomed-out look: once the requested window exceeds
 * the source's own bounds (sx/sy go negative, or sx+sWidth/sy+sHeight
 * exceed sourceWidth/sourceHeight), a canvas drawImage clips the source
 * rect to the source's real bounds and shrinks the destination rect by the
 * same proportion -- so the footage progressively shrinks within its own
 * destination box (revealing whatever's already drawn behind it) the
 * further `zoom` drops below 1, with no separate letterboxing logic needed
 * at the call site. Only ever pass a `minZoom` below 1 for a
 * Picture-in-Picture box, which has a backdrop behind it worth revealing --
 * see OverlayFraming.zoom's own doc comment. */
export function computeCoverFitSourceRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  panX: number = 0.5,
  panY: number = 0.5,
  zoom: number = 1,
  minZoom: number = 1
): { sx: number; sy: number; sWidth: number; sHeight: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return { sx: 0, sy: 0, sWidth: sourceWidth, sHeight: sourceHeight };
  }
  const clampedPanX = Math.min(Math.max(panX, 0), 1);
  const clampedPanY = Math.min(Math.max(panY, 0), 1);
  const clampedZoom = Math.max(zoom, minZoom);
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;
  const { coverWidth, coverHeight } =
    sourceRatio > targetRatio
      ? { coverWidth: sourceHeight * targetRatio, coverHeight: sourceHeight }
      : { coverWidth: sourceWidth, coverHeight: sourceWidth / targetRatio };

  const sWidth = coverWidth / clampedZoom;
  const sHeight = coverHeight / clampedZoom;
  return {
    sx: (sourceWidth - sWidth) * clampedPanX,
    sy: (sourceHeight - sHeight) * clampedPanY,
    sWidth,
    sHeight,
  };
}

/** Where to draw `targetRatio`-shaped content inside a `containerWidth` x
 * `containerHeight` box so it's letterboxed (never stretched) -- the pixel
 * equivalent of CSS `object-fit: contain`, for a canvas whose own drawImage
 * destination isn't automatically shaped by CSS the way an <img>'s is.
 * Shared by CutawayDialog.tsx and MobileImageTemplatePicker.tsx's own
 * animated Ken Burns previews, both of which have a FIXED-aspect preview
 * canvas buffer (e.g. 960x540 or a square) regardless of the project's
 * actual clip-rectangle ratio -- drawing straight into
 * `0,0,canvas.width,canvas.height` silently stretches any crop whose own
 * ratio doesn't match the buffer's, which for this app's default 9:16
 * reels was every single one. */
export function computeContainRect(
  containerWidth: number,
  containerHeight: number,
  targetRatio: number
): { x: number; y: number; width: number; height: number } {
  const containerRatio = containerWidth / containerHeight;
  if (targetRatio > containerRatio) {
    const width = containerWidth;
    const height = width / targetRatio;
    return { x: 0, y: (containerHeight - height) / 2, width, height };
  }
  const height = containerHeight;
  const width = height * targetRatio;
  return { x: (containerWidth - width) / 2, y: 0, width, height };
}

/**
 * Text composited on top of the base video for a time range, rendered via
 * a named template (see lib/video/textTemplates.ts) rather than free-form
 * styling -- the template owns font/color/animation, this just says WHAT
 * text, WHICH template, WHERE (rect, same fractional shape as
 * OverlayImage's), and WHEN.
 */
export interface TextOverlay {
  text: string;
  templateId: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  rect: CropRect;
}

// Default placement for a freshly-added text overlay -- the bottom third,
// the conventional caption-safe zone, rather than dead-center. Exported
// (rather than kept local to transformations.ts) since TextOverlayDialog
// also needs it as the starting rect for a brand new overlay, before
// there's any TextOverlay object yet to read a rect from.
export const DEFAULT_TEXT_OVERLAY_RECT: CropRect = { x: 0.1, y: 0.7, width: 0.8, height: 0.2 };

/**
 * Auto-generated, speech-driven captions -- Creatomate's own transcription
 * (see lib/video/transcriptCaptionTemplates.ts and
 * lib/timeline/compileCreatomateTimeline.ts), as opposed to TextOverlay's
 * manually-typed captions. One config for the whole video, not a
 * time-ranged list: there's no text to author a range around, it's simply
 * enabled or not, with one style and one position. Never rendered in the
 * live Canvas2D preview -- transcription only happens server-side, during
 * an actual render (see CanvasPlayer.tsx's own comment on why it
 * deliberately shows nothing for this).
 */
export interface TranscriptCaption {
  templateId: string;
  rect: CropRect;
}

// Same bottom-third caption-safe default as text overlays.
export const DEFAULT_TRANSCRIPT_CAPTION_RECT: CropRect = { x: 0.1, y: 0.7, width: 0.8, height: 0.2 };

/** Every text overlay visible at `timeSeconds` -- same multiple-at-once,
 * half-open-interval semantics as findActiveOverlays above. */
export function findActiveTextOverlays(overlays: TextOverlay[], timeSeconds: number): TextOverlay[] {
  return overlays.filter((overlay) => timeSeconds >= overlay.startTimeSeconds && timeSeconds < overlay.endTimeSeconds);
}

/** One word's exact timing within a TTS synthesis result -- see TtsOverlay
 * below. Millisecond ints, matching the backend's own wire units, since
 * these are compared against a millisecond playhead offset every preview
 * tick (see CanvasPlayer.tsx's karaoke renderer) with no unit conversion
 * needed at that hot call site. */
export interface TtsWordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

/**
 * TTS-generated narration composited on top of the base video for a time
 * range -- the audio comes from a backend speech-synthesis call (assetId
 * points at the generated mp3, same private-asset-then-presigned-URL
 * pattern as everything else), and its on-screen text is either a static
 * captioned block (same template system as TextOverlay), word-by-word
 * "karaoke" highlighting driven by wordTimings (exact per-word timestamps
 * from the synthesis itself, not ASR -- this is why karaoke mode CAN be
 * live-previewed accurately, unlike TranscriptCaption), or no text at all
 * ("none" -- the narration plays as audio only, nothing drawn on screen;
 * `rect`/`templateId` are simply unused in this mode, kept set rather than
 * made optional so every TtsOverlay still has one consistent shape).
 */
export interface TtsOverlay {
  text: string;
  voice: string;
  assetId: string;
  durationSeconds: number;
  wordTimings: TtsWordTiming[];
  startTimeSeconds: number;
  displayMode: "background" | "karaoke" | "none";
  rect: CropRect;
  // TextTemplateId -- used for the caption's own font/color when
  // displayMode === "background", and as the karaoke text's base look too.
  // Always set (defaults to the first TEXT_TEMPLATE_OPTIONS entry).
  templateId: string;
  // 0..1, default 1 -- see CanvasPlayer.tsx's own per-overlay gain node.
  volume: number;
}

// Same bottom-third caption-safe default as text overlays.
export const DEFAULT_TTS_OVERLAY_RECT: CropRect = { x: 0.1, y: 0.7, width: 0.8, height: 0.2 };

// Deliberately NOT a stored field (unlike TextOverlay.endTimeSeconds) --
// derived from startTimeSeconds + durationSeconds, since duration comes
// from the real generated audio (durationSeconds, from the synthesis
// response), not free authoring. Only startTimeSeconds is ever
// user-editable (drag to reposition in time); the overlay's rect is still
// drag/resize-able in space same as a text overlay.
export function ttsOverlayEndTimeSeconds(overlay: TtsOverlay): number {
  return overlay.startTimeSeconds + overlay.durationSeconds;
}

/** Every TTS overlay visible at `timeSeconds` -- same multiple-at-once,
 * half-open-interval semantics as findActiveTextOverlays above. */
export function findActiveTtsOverlays(overlays: TtsOverlay[], timeSeconds: number): TtsOverlay[] {
  return overlays.filter((overlay) => timeSeconds >= overlay.startTimeSeconds && timeSeconds < ttsOverlayEndTimeSeconds(overlay));
}

/** Which word (if any) of a TtsOverlay's exact synthesis-provided timings is
 * "speaking" at `timeSeconds` -- word_timings are milliseconds relative to
 * the narration's OWN start, so this converts timeSeconds (the sequence's
 * own clock, same one findActiveTtsOverlays uses) down to that same
 * relative-ms scale first. Unlike TranscriptCaption (ASR, ~second-level
 * accuracy, deliberately never live-previewed -- see its own doc comment
 * above), these timings come straight from the synthesis engine, so a live
 * per-word highlight is trustworthy, not just an approximation -- both
 * CanvasPlayer.tsx's live preview and exportTimeline.ts's offline render
 * call this so the two never disagree on which word is highlighted when. */
export function findActiveWordIndex(overlay: TtsOverlay, timeSeconds: number): number {
  const relativeMs = (timeSeconds - overlay.startTimeSeconds) * 1000;
  return overlay.wordTimings.findIndex((w) => relativeMs >= w.startMs && relativeMs < w.endMs);
}

/** How far `timeSeconds` is through a [startTimeSeconds, endTimeSeconds)
 * window, as a 0..1 fraction clamped at both ends -- what every text
 * template renderer uses to drive its own entrance/exit animation, so
 * each template only ever has to reason about "progress," never about
 * clock time directly. */
export function computeProgress(startTimeSeconds: number, endTimeSeconds: number, timeSeconds: number): number {
  const duration = endTimeSeconds - startTimeSeconds;
  if (duration <= 0) return 1;
  return Math.min(Math.max((timeSeconds - startTimeSeconds) / duration, 0), 1);
}

/** "1:05–1:42"-style summary of a time range -- shared by ActionArea's own
 * ActiveTransformationsList and every "existing overlays" list the overlay
 * picker dialogs show (VideoOverlayPickerDialog/ImageOverlayPickerDialog/
 * TextOverlayDialog), so the two never drift apart into two different mm:ss
 * conventions. */
export function formatTimeRange(startTimeSeconds: number, endTimeSeconds: number): string {
  const format = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const wholeSeconds = Math.floor(seconds % 60);
    return `${minutes}:${wholeSeconds.toString().padStart(2, "0")}`;
  };
  return `${format(startTimeSeconds)}–${format(endTimeSeconds)}`;
}

/** "Full-Screen"/"Picture-in-Picture"/"Split Screen" -- same three labels
 * ActionArea's ActiveTransformationsList and VideoOverlayTrack/
 * ImageOverlayTrack's own right-click "Switch to X" menu already use,
 * shared here so a fourth caller (the overlay picker dialogs' own
 * "existing overlays" list) can't drift from that wording. */
export function describeOverlayLayout(layout: { type: string }): string {
  return layout.type === "full-screen" ? "Full-Screen" : layout.type === "picture-in-picture" ? "Picture-in-Picture" : "Split Screen";
}

/** The index into `timestamps` closest to `targetSeconds` -- e.g. picking
 * which extracted thumbnail best represents the current playhead position.
 * Not an even-spacing formula (see FrameStrip.tsx's own comment on why
 * that breaks once thumbnails are concatenated from multiple clips):
 * a real linear scan against each tile's own timestamp. Returns -1 for an
 * empty list. */
export function findClosestTimestampIndex(timestamps: number[], targetSeconds: number): number {
  if (timestamps.length === 0) return -1;
  let closestIndex = 0;
  let closestDistance = Infinity;
  for (let index = 0; index < timestamps.length; index++) {
    const distance = Math.abs(timestamps[index] - targetSeconds);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  }
  return closestIndex;
}

/**
 * One clip's place within a concatenated sequence -- a video-in-video-out
 * multi-clip timeline (right-click "Add" on a video/music asset) or a
 * multi-track background-music sequence both build a list of these. Pure
 * bookkeeping: which asset, its own duration, and its cumulative
 * `startTimeSeconds` once every earlier clip's duration is added up.
 * `kind` defaults to "video" for callers that don't pass one (every
 * pre-existing call site -- background music, the local/cloud render
 * gatherers before image clips existed) so it's optional on input but
 * always present on the built info.
 */
export interface SequenceClipInfo {
  // The originating SequenceEntry.id, when this info was built from real
  // sequence clips (gatherRenderClips.ts/gatherLocalRenderClips.ts) --
  // absent for background-music tracks (BackgroundTrackStrip.tsx) and
  // CanvasPlayer's own live-preview loader, neither of which has (or needs)
  // a per-entry filter to look up. Carried onto RenderSegment.entryId by
  // buildRenderSegments below so the compiler can resolve each rendered
  // segment back to the cutaway it came from.
  id?: string;
  assetId: string;
  url: string;
  durationSeconds: number;
  startTimeSeconds: number;
  kind: "video" | "image";
  // This clip's own real pixel dimensions -- absent for a background-music
  // track (no visual shape) or wherever it hasn't been probed yet.
  // reprojectCropRect (above) needs a clip's OWN aspect ratio to correctly
  // re-project the reference clip's authored crop rect onto it, instead of
  // reusing that rect's raw fractions against a differently-shaped clip
  // (which stretches rather than crops -- see that function's own doc
  // comment). Probed client-side alongside durationSeconds -- see
  // lib/localRender/gatherLocalRenderClips.ts and lib/timeline/gatherRenderClips.ts.
  width?: number;
  height?: number;
}

export function buildSequenceClipInfos(
  clips: {
    id?: string;
    assetId: string;
    url: string;
    durationSeconds: number;
    kind?: "video" | "image";
    width?: number;
    height?: number;
  }[]
): SequenceClipInfo[] {
  let cursor = 0;
  return clips.map((clip) => {
    const info: SequenceClipInfo = { ...clip, kind: clip.kind ?? "video", startTimeSeconds: cursor };
    cursor += clip.durationSeconds;
    return info;
  });
}

/**
 * One entry in the base video sequence -- either a video asset (just an id;
 * duration is always re-probed from the file, never authored) or an image
 * asset animated via one or more combined Ken Burns templates
 * (lib/video/imageTemplates.ts), which needs an authored `durationSeconds`
 * (images have no intrinsic duration), a `templateIds` list (one id per
 * axis -- zoom/pan-h/pan-v -- composed into a single motion, see
 * imageTemplates.ts's kenBurnsRects), and a `cropRect`: the clip rectangle
 * positioned for THIS photo specifically (fractions of the photo's own
 * naturalWidth/naturalHeight) -- NOT the project's overall video-frame clip
 * rectangle, which has unrelated dimensions. Every entry carries its own
 * `id`, generated once when it's added (see transformations.ts's
 * applyAddSequenceClip/applyAddImageSequenceClip) -- NOT the same as
 * `assetId`, since the same asset can appear more than once (two image clips
 * from the same photo, each with its own duration/template/crop) and needs
 * to be addressed independently by everything downstream (thumbnail
 * extraction, live preview, the per-clip duration drag on FrameStrip).
 */
export type SequenceEntry =
  | {
      id: string;
      kind: "video";
      assetId: string;
      colorFilterId?: FilterPresetId | null;
      cutTransitionInId?: CutTransitionId | null;
      canvasFillMode?: CanvasFillMode | null;
      canvasFillColor?: string;
      canvasFillGradientColor?: string;
      // AI background removal (see CutawayDialog.tsx's "Remove background"
      // toggle) -- also present on the "image" variant below for a Ken
      // Burns cutaway (a still photo's own matting job is synchronous, a
      // different provider path server-side, but the same field shape).
      // Keyed
      // by the SAME assetId this entry already carries: matteAssetId's
      // owning background_removals row is looked up server-side by
      // source_asset_id (= this entry's assetId), not by entry id, so the
      // same clip reused across multiple cutaways shares one matting job.
      // `matteAssetId` is null while the async job is still running/queued
      // -- compileCreatomateTimeline.ts falls back to a plain (non-masked)
      // segment until it's populated (see buildBackgroundRemovedSegment's
      // own comment).
      backgroundRemoval?: BackgroundRemovalState | null;
    }
  | {
      id: string;
      kind: "image";
      assetId: string;
      durationSeconds: number;
      templateIds?: string[];
      /** @deprecated superseded by templateIds -- kept only so cutaways
       * persisted before multi-select existed still type-check. Never
       * written by new code; read only via imageTemplates.ts's
       * normalizeImageTemplateIds. */
      templateId?: string;
      cropRect?: CropRect;
      // Same per-clip color filter as the "video" variant above -- see
      // VideoOverlayClip.colorFilterId's doc comment.
      colorFilterId?: FilterPresetId | null;
      cutTransitionInId?: CutTransitionId | null;
      // Same per-clip canvas fill as the "video" variant above -- see
      // canvasFillPresets.ts's own doc comment. Absent/null means "crop"
      // (today's only behavior, unchanged for every reel saved before this
      // existed).
      canvasFillMode?: CanvasFillMode | null;
      canvasFillColor?: string;
      canvasFillGradientColor?: string;
      // Same AI background removal as the "video" variant above -- see its
      // own doc comment. A photo's own matting job (backend/src/matting/
      // service.py's image-kind path) calls a synchronous image-matting
      // provider (rembg via fal.ai) rather than VEED's async video job, so
      // matteAssetId is often populated almost immediately rather than
      // after a real poll loop -- but the field shape, and how
      // compileCreatomateTimeline.ts/CanvasPlayer consume it, is identical
      // either way.
      backgroundRemoval?: BackgroundRemovalState | null;
      // "Make it 3D" toggle (lib/video/camera3D.ts) -- layers auto-derived
      // tilt/roll/perspective on top of whatever templateIds motion is
      // already authored (the dolly), rather than being its own effect with
      // its own timing. Absent/false means today's flat 2D Ken Burns,
      // unchanged. Only meaningful on the image variant -- a plain video
      // cutaway has no pan/zoom motion to attach a dolly to.
      camera3D?: boolean;
      // A subtle looping overlay (light sweep / sparkle / leaves, see
      // ambientEffects.ts), independent of camera3D above -- same
      // image-only scoping as camera3D, for now (no picker exists yet for
      // the "video" variant below). Absent/null means none.
      ambientEffect?: AmbientEffectId | null;
    };

// Both SequenceEntry variants above carry a `cutTransitionInId` -- which
// blended-cut transition (see cutTransitionPresets.ts) plays INTO this clip
// from whichever clip precedes it in sequenceClips. Deliberately named
// "cutTransition", never bare "transition" -- this codebase already uses
// "transition" for the OLDER, unrelated pan/zoom Ken Burns effect (see
// ZoomEffect below and transformations.ts's own "transition" labels).
// Meaningless (never set/read) on sequenceClips[0], since nothing precedes
// it.

export function sequenceEntryAssetId(entry: SequenceEntry): string {
  return entry.assetId;
}

export function totalSequenceDuration(clips: SequenceClipInfo[]): number {
  return clips.reduce((sum, clip) => sum + clip.durationSeconds, 0);
}

// The background-music volume every reel started with before
// Timeline.backgroundVolume existed -- read as that field's fallback
// wherever it's absent (CanvasPlayer.tsx's live preview,
// lib/localRender/exportTimeline.ts's offline mix,
// compileCreatomateTimeline.ts's actual render), so an old reel's rendered
// loudness doesn't change out from under it just by opening it again.
export const DEFAULT_BACKGROUND_VOLUME = 0.5;
// Same role for Timeline.mainAudioVolume -- the main sequence's own audio
// always played back unducked at full volume before that field existed.
export const DEFAULT_MAIN_AUDIO_VOLUME = 1;

/**
 * Which clip (and the local offset within it) a global elapsed-seconds
 * position in the concatenated sequence falls on -- what lets CanvasPlayer
 * keep treating "the sequence" as one continuous virtual clip: everything
 * else (crop/zoom/flip/trim/overlay) only ever deals in elapsedSeconds
 * against the sequence's own total duration and never needs to know clips
 * exist. Clamps into the last clip past the sequence's own end (mirrors
 * frameIndexAtTime's clamping) rather than returning null there, since
 * playback logic always calls this with an already-clamped time.
 */
export function resolveSequencePosition(
  clips: SequenceClipInfo[],
  elapsedSeconds: number
): { clipIndex: number; localSeconds: number } | null {
  if (clips.length === 0) return null;
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    if (elapsedSeconds < clip.startTimeSeconds + clip.durationSeconds || i === clips.length - 1) {
      return { clipIndex: i, localSeconds: elapsedSeconds - clip.startTimeSeconds };
    }
  }
  return null;
}

/**
 * CanvasPlayer-only cut-transition support. Unlike buildRenderSegments (the
 * Creatomate/local-export OUTPUT timeline, which is free to shift its own
 * outputStartSeconds since it's a separate axis from the ORIGINAL timeline
 * ZoomEffect/overlay/text/TTS ranges are authored against), CanvasPlayer
 * conflates "which clip's frame to show" and "evaluate every authored-range
 * effect" into the SAME elapsedSeconds clock -- shifting SequenceClipInfo's
 * own startTimeSeconds here would drag every authored absolute-time effect
 * on every clip AFTER a transition out of sync with where the user actually
 * placed it. So clip start times stay exactly as they are today (a plain
 * hard-cut concatenation); the blend is instead layered on top via these two
 * helpers, reusing the SAME "skip a stretch of dead time" mechanism trims
 * already use (skipTrimmedRanges) rather than a second timeline axis.
 */

/** Non-null only while elapsedSeconds sits inside an active cut-transition
 * PREVIEW window -- the CUT_TRANSITION_DURATION_SECONDS just before the
 * incoming clip's own real (unshifted) start. Gives drawFrameAt everything
 * needed to blend the outgoing clip's normal frame with an early preview of
 * the incoming clip's own opening frames: `toLocalSeconds` is the incoming
 * clip's own local time to sample for that preview (0 at the window's
 * start, `overlapSeconds` at its end -- continuous with the real local time
 * it'll have once actual playback reaches it), and `progress` (0..1) is how
 * much to favor the incoming clip already. */
export function resolveCutTransitionBlend(
  clips: SequenceClipInfo[],
  cutTransitionByEntryId: Map<string, CutTransitionId | null | undefined>,
  elapsedSeconds: number
): { fromIndex: number; toIndex: number; toLocalSeconds: number; progress: number; overlapSeconds: number } | null {
  for (let i = 1; i < clips.length; i++) {
    const clip = clips[i];
    const cutTransitionInId = clip.id ? cutTransitionByEntryId.get(clip.id) ?? null : null;
    const overlapSeconds = resolveCutTransitionOverlapSeconds(cutTransitionInId, true, clips[i - 1].durationSeconds, clip.durationSeconds);
    if (overlapSeconds <= 0) continue;
    const windowStart = clip.startTimeSeconds - overlapSeconds;
    if (elapsedSeconds < windowStart || elapsedSeconds >= clip.startTimeSeconds) continue;
    const toLocalSeconds = elapsedSeconds - windowStart;
    return { fromIndex: i - 1, toIndex: i, toLocalSeconds, progress: toLocalSeconds / overlapSeconds, overlapSeconds };
  }
  return null;
}

/** The redundant stretch [clip.startTimeSeconds, clip.startTimeSeconds +
 * overlapSeconds) of EVERY transitioned clip -- already fully shown as the
 * early preview resolveCutTransitionBlend renders above, so real playback
 * must skip past it once the clock reaches it (else the incoming clip's own
 * opening would play twice: once blended-in, once "for real"). Fed into
 * skipTrimmedRanges/resumePlaybackFrom ALONGSIDE the user's own real
 * trimRanges (never into TrimTrack's own UI, which shows only genuine
 * user-authored cuts) -- same skip mechanism, a synthetic reason to use it. */
export function buildVirtualCutTransitionSkipRanges(
  clips: SequenceClipInfo[],
  cutTransitionByEntryId: Map<string, CutTransitionId | null | undefined>
): TrimRange[] {
  const ranges: TrimRange[] = [];
  for (let i = 1; i < clips.length; i++) {
    const clip = clips[i];
    const cutTransitionInId = clip.id ? cutTransitionByEntryId.get(clip.id) ?? null : null;
    const overlapSeconds = resolveCutTransitionOverlapSeconds(cutTransitionInId, true, clips[i - 1].durationSeconds, clip.durationSeconds);
    if (overlapSeconds <= 0) continue;
    ranges.push({ startTimeSeconds: clip.startTimeSeconds, endTimeSeconds: clip.startTimeSeconds + overlapSeconds });
  }
  return ranges;
}

/**
 * One contiguous stretch of the OUTPUT (post-trim) render timeline, all
 * from a single physical clip -- what the Creatomate compiler emits one
 * `Video` element per (lib/timeline/compileCreatomateTimeline.ts).
 * `zoomEffects`/flip toggles/overlay time ranges are all authored against
 * the ORIGINAL (pre-trim) concatenated-sequence timeline -- the same one
 * `sourceStartSeconds` here is in -- since that's what CanvasPlayer's own
 * elapsed-seconds clock uses throughout (skipTrimmedRanges only jumps the
 * playback clock forward past a cut, it never renumbers anything). See
 * mapSourceRangeToOutputRanges for translating an original-timeline window
 * (a ZoomEffect's active range, an overlay's visible range) into its
 * OUTPUT-time equivalent(s).
 */
export interface RenderSegment {
  assetId: string;
  /** The originating SequenceClipInfo.id (in turn SequenceEntry.id) --
   * absent when built from clips with no entry id (background music).
   * Lets the compiler look up this segment's own colorFilterId even after
   * a trim has split one cutaway into several segments. */
  entryId?: string;
  /** Which kind of clip this segment came from -- determines whether the
   * compiler emits a Creatomate Video (with trimStart/trimDuration) or an
   * Image (no source trim, since a still image has no timeline of its own)
   * for it. See lib/timeline/compileCreatomateTimeline.ts. */
  kind: "video" | "image";
  // The originating SequenceClipInfo's own real pixel dimensions, when
  // known -- see that field's own doc comment (reprojectCropRect needs
  // this to re-project the sequence's reference-clip-authored crop rect
  // onto THIS segment's own real aspect ratio).
  width?: number;
  height?: number;
  sourceStartSeconds: number;
  /** This clip's own local offset where this segment begins -- Creatomate's Video.trimStart. */
  clipLocalStartSeconds: number;
  /** Also this segment's duration in OUTPUT time -- trimming removes stretches, it never changes playback speed. */
  durationSeconds: number;
  outputStartSeconds: number;
  /** Set only on the FIRST surviving segment of an entry that has a
   * cutTransitionInId AND has a previous segment to blend with -- outputStartSeconds
   * above already has cutTransitionOverlapSeconds subtracted, so this segment's
   * output window genuinely overlaps the end of the segment immediately
   * before it in this array. Absent/null everywhere else (a hard cut). */
  cutTransitionInId?: CutTransitionId | null;
  /** The actual overlap (seconds) applied for cutTransitionInId, already
   * baked into outputStartSeconds above -- 0 when cutTransitionInId is absent. */
  cutTransitionOverlapSeconds?: number;
}

/** How much an incoming segment/clip's OUTPUT start shifts EARLIER to
 * overlap the one immediately before it, for a blended cut-transition -- 0
 * when there's nothing before it or no transition is set. Clamped so the
 * overlap never exceeds either neighbor's own duration (a very short clip
 * either side of the cut shouldn't produce a negative remaining duration).
 * Shared by buildRenderSegments below (the Creatomate/local-export OUTPUT
 * timeline) and CanvasPlayer's own transition-blend math (which uses the
 * SAME clamp against the ORIGINAL, unshifted SequenceClipInfo list -- see
 * resolveCutTransitionBlend) so every consumer agrees on exactly the same
 * overlap amount. */
export function resolveCutTransitionOverlapSeconds(
  cutTransitionInId: CutTransitionId | null | undefined,
  hasPrevious: boolean,
  prevDurationSeconds: number,
  thisDurationSeconds: number
): number {
  if (!cutTransitionInId || !hasPrevious) return 0;
  return Math.max(0, Math.min(CUT_TRANSITION_DURATION_SECONDS, prevDurationSeconds, thisDurationSeconds));
}

/** The output-timeline (RenderSegment) counterpart to CanvasPlayer's own
 * resolveCutTransitionBlend, used by exportTimeline.ts's frame-by-frame
 * local render -- segments already carry their own real, already-shifted
 * outputStartSeconds (see buildRenderSegments), so unlike CanvasPlayer this
 * needs no separate skip trick: a segment's own sourceStartSeconds/
 * clipLocalStartSeconds already give the correct sample position for
 * whatever outputTimeSeconds falls within its (possibly overlapping)
 * output window. Non-null only while outputTimeSeconds sits inside a
 * transitioned segment's own overlap window. */
export function resolveRenderSegmentBlend(
  segments: RenderSegment[],
  outputTimeSeconds: number
): { fromSegment: RenderSegment; toSegment: RenderSegment; progress: number } | null {
  for (let i = 1; i < segments.length; i++) {
    const toSegment = segments[i];
    const overlapSeconds = toSegment.cutTransitionOverlapSeconds ?? 0;
    if (overlapSeconds <= 0) continue;
    if (outputTimeSeconds < toSegment.outputStartSeconds || outputTimeSeconds >= toSegment.outputStartSeconds + overlapSeconds) continue;
    return { fromSegment: segments[i - 1], toSegment, progress: (outputTimeSeconds - toSegment.outputStartSeconds) / overlapSeconds };
  }
  return null;
}

/** Sum of RenderSegment durations overcounts once transitions overlap two
 * segments' windows -- the real total is however far the LAST segment's own
 * output window reaches, not a naive sum. Every consumer that needs "the
 * output video's total duration" (background-music loop length, the flip
 * wrapper's own keyframe span, overlay-range clamping against the output
 * timeline) must use this instead of summing durationSeconds directly. */
export function totalRenderOutputDuration(segments: RenderSegment[]): number {
  return segments.reduce((max, s) => Math.max(max, s.outputStartSeconds + s.durationSeconds), 0);
}

// A segment shorter than this (typically left over when a trim edge lands
// almost exactly on a clip boundary) is dropped rather than emitted as a
// near-zero-duration render element, which Creatomate would likely reject.
const MIN_SEGMENT_DURATION_SECONDS = 0.02;

/** The complement of `trimRanges` within [0, totalDurationSeconds) -- the
 * stretches that SURVIVE trimming, in order. Merges overlapping/touching
 * ranges first so the gaps between them are well-defined. */
export function invertTrimRanges(trimRanges: TrimRange[], totalDurationSeconds: number): TrimRange[] {
  const merged = mergeTrimRanges(trimRanges);
  const kept: TrimRange[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.startTimeSeconds > cursor) {
      kept.push({ startTimeSeconds: cursor, endTimeSeconds: range.startTimeSeconds });
    }
    cursor = Math.max(cursor, range.endTimeSeconds);
  }
  if (cursor < totalDurationSeconds) {
    kept.push({ startTimeSeconds: cursor, endTimeSeconds: totalDurationSeconds });
  }
  return kept;
}

// How close subStart needs to land to a clip's own startTimeSeconds to
// count as "the first surviving bit of this physical clip" (rather than a
// mid-clip split from a trim cut) -- floating-point cumulative sums can be
// off by a hair, and a cutTransition should only ever apply at a clip's
// genuine start.
const CLIP_START_EPSILON_SECONDS = 0.001;

/**
 * Turns an ordered clip sequence + trim ranges into contiguous OUTPUT
 * segments. Splits every kept (post-trim) stretch further at each clip
 * boundary, so no segment ever spans more than one physical clip, even
 * when a trim cuts across the seam between two clips. `cutTransitionByEntryId`
 * (entry id -> its own cutTransitionInId, absent/empty for a sequence with no
 * transitions) lets a segment that's the genuine first surviving bit of an
 * entry with a transition overlap the segment immediately before it in the
 * OUTPUT timeline -- see resolveCutTransitionOverlapSeconds. A segment
 * resulting from a trim that cuts INTO a transitioned clip's own head never
 * gets the overlap (there's no undamaged "start of this clip" left to blend
 * from) -- an accepted limitation, same as this project's other trim-vs.-
 * feature edge cases.
 */
export function buildRenderSegments(
  clips: SequenceClipInfo[],
  trimRanges: TrimRange[],
  cutTransitionByEntryId?: Map<string, CutTransitionId | null | undefined>
): RenderSegment[] {
  const totalDurationSeconds = totalSequenceDuration(clips);
  const keptRanges = invertTrimRanges(trimRanges, totalDurationSeconds);
  const clipBoundaries = clips.map((clip) => clip.startTimeSeconds);

  const segments: RenderSegment[] = [];
  let outputCursor = 0;

  for (const range of keptRanges) {
    const splitPoints = [
      range.startTimeSeconds,
      ...clipBoundaries.filter((b) => b > range.startTimeSeconds && b < range.endTimeSeconds),
      range.endTimeSeconds,
    ];

    for (let i = 0; i < splitPoints.length - 1; i++) {
      const subStart = splitPoints[i];
      const subEnd = splitPoints[i + 1];
      const durationSeconds = subEnd - subStart;
      if (durationSeconds < MIN_SEGMENT_DURATION_SECONDS) continue;

      const position = resolveSequencePosition(clips, subStart);
      if (!position) continue;
      const clip = clips[position.clipIndex];

      const isClipStart = Math.abs(subStart - clip.startTimeSeconds) < CLIP_START_EPSILON_SECONDS;
      const cutTransitionInId = isClipStart && clip.id ? cutTransitionByEntryId?.get(clip.id) ?? null : null;
      const overlapSeconds = resolveCutTransitionOverlapSeconds(
        cutTransitionInId,
        segments.length > 0,
        segments[segments.length - 1]?.durationSeconds ?? 0,
        durationSeconds
      );

      const outputStartSeconds = outputCursor - overlapSeconds;
      segments.push({
        assetId: clip.assetId,
        entryId: clip.id,
        kind: clip.kind,
        width: clip.width,
        height: clip.height,
        sourceStartSeconds: subStart,
        clipLocalStartSeconds: subStart - clip.startTimeSeconds,
        durationSeconds,
        outputStartSeconds,
        cutTransitionInId: overlapSeconds > 0 ? cutTransitionInId : null,
        cutTransitionOverlapSeconds: overlapSeconds,
      });
      outputCursor = outputStartSeconds + durationSeconds;
    }
  }

  return segments;
}

/**
 * Intersects [sourceStartSeconds, sourceEndSeconds) -- an overlay's visible
 * window, a ZoomEffect's active window, a flip segment -- against every
 * RenderSegment's own source window, translating each overlap into its
 * OUTPUT-time equivalent. Returns more than one range when a trim cuts
 * through the middle of the original window: the survivors on either side
 * of the cut land at non-adjacent output times, and both are real, so both
 * come back rather than only the first.
 */
export function mapSourceRangeToOutputRanges(
  segments: RenderSegment[],
  sourceStartSeconds: number,
  sourceEndSeconds: number
): { outputStartSeconds: number; outputEndSeconds: number; sourceOverlapStartSeconds: number; sourceOverlapEndSeconds: number }[] {
  const ranges: { outputStartSeconds: number; outputEndSeconds: number; sourceOverlapStartSeconds: number; sourceOverlapEndSeconds: number }[] = [];
  for (const segment of segments) {
    const segmentSourceEnd = segment.sourceStartSeconds + segment.durationSeconds;
    const overlapStart = Math.max(sourceStartSeconds, segment.sourceStartSeconds);
    const overlapEnd = Math.min(sourceEndSeconds, segmentSourceEnd);
    if (overlapEnd <= overlapStart) continue;

    ranges.push({
      outputStartSeconds: segment.outputStartSeconds + (overlapStart - segment.sourceStartSeconds),
      outputEndSeconds: segment.outputStartSeconds + (overlapEnd - segment.sourceStartSeconds),
      sourceOverlapStartSeconds: overlapStart,
      sourceOverlapEndSeconds: overlapEnd,
    });
  }
  return ranges;
}

const DEFAULT_OUTPUT_LONG_EDGE_PX = 1920;

/** Output pixel dimensions for a render, derived from the selected clip
 * rectangle's ratio (width/height) rather than a fixed resolution -- this
 * app supports 6 different output shapes (see ClipRectIcon.tsx's
 * CLIP_RECT_OPTIONS), not just portrait. Long edge fixed at `longEdgePx`;
 * both dimensions rounded to the nearest even number, since H.264 requires
 * even width/height. */
export function computeOutputDimensions(
  targetRatio: number,
  longEdgePx: number = DEFAULT_OUTPUT_LONG_EDGE_PX
): { width: number; height: number } {
  const roundToEven = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return targetRatio >= 1
    ? { width: roundToEven(longEdgePx), height: roundToEven(longEdgePx / targetRatio) }
    : { width: roundToEven(longEdgePx * targetRatio), height: roundToEven(longEdgePx) };
}
