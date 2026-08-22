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

// Spec: the resize notch can stretch a panel's height to within +/-25% of
// its initial value ("either way from initial value") -- not +/-25% of
// whatever it's currently at, which would let repeated drags creep past the
// limit.
export const DEFAULT_MAX_STRETCH_RATIO = 0.25;

/**
 * Clamps a candidate panel height to +/-`maxStretchRatio` of its initial
 * value. Used by ResizablePanel while dragging its top notch (the bottom
 * edge never moves -- only the top does, so only height needs clamping).
 * Clamped in pixels rather than clamping the drag delta itself, so the
 * result stays correct however far the pointer has moved past the limit.
 */
export function clampPanelHeight(
  initialHeightPx: number,
  candidateHeightPx: number,
  maxStretchRatio: number = DEFAULT_MAX_STRETCH_RATIO
): number {
  const min = initialHeightPx * (1 - maxStretchRatio);
  const max = initialHeightPx * (1 + maxStretchRatio);
  return Math.min(Math.max(candidateHeightPx, min), max);
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

export interface ZoomEffect {
  startTimeSeconds: number;
  endTimeSeconds: number;
  startRect: CropRect;
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
 */
export function computeEffectiveCropRect(
  baseCropRect: CropRect,
  zoomEffects: ZoomEffect[],
  timeSeconds: number
): CropRect {
  const activeIndex = findActiveZoomEffectIndex(zoomEffects, timeSeconds);
  if (activeIndex === -1) return baseCropRect;

  const zoomEffect = zoomEffects[activeIndex];
  const duration = zoomEffect.endTimeSeconds - zoomEffect.startTimeSeconds;
  const t = duration > 0 ? (timeSeconds - zoomEffect.startTimeSeconds) / duration : 1;
  return interpolateCropRect(zoomEffect.startRect, zoomEffect.endRect, t);
}

/**
 * Root-mean-square loudness of `samples` (mono, -1..1 range), one value per
 * `bucketSeconds` window, normalized so the loudest bucket in the clip is
 * 1.0. Normalizing per-clip (rather than against a fixed reference level)
 * keeps the volume graph readable regardless of the source recording's
 * absolute levels.
 */
export function computeVolumeBuckets(samples: Float32Array, sampleRate: number, bucketSeconds: number): number[] {
  if (samples.length === 0 || sampleRate <= 0 || bucketSeconds <= 0) return [];

  const bucketSizeSamples = Math.max(1, Math.round(sampleRate * bucketSeconds));
  const buckets: number[] = [];

  for (let start = 0; start < samples.length; start += bucketSizeSamples) {
    const end = Math.min(start + bucketSizeSamples, samples.length);
    let sumOfSquares = 0;
    for (let i = start; i < end; i++) {
      sumOfSquares += samples[i] * samples[i];
    }
    buckets.push(Math.sqrt(sumOfSquares / (end - start)));
  }

  const MIN_PEAK = 1e-6; // guards against divide-by-zero on a silent/empty track
  const peak = Math.max(...buckets, MIN_PEAK);
  return buckets.map((value) => value / peak);
}
