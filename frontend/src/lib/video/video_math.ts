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
 * An image asset composited on top of the base video for a time range --
 * a picture-in-picture layer, not a crop/zoom/flip of the base clip
 * itself. `rect` is the SAME fractional {x,y,width,height} shape as
 * CropRect (position/size as fractions of the frame) -- it's generic
 * rectangle geometry, just describing where the overlay sits rather than
 * what to crop.
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
  // matching every framing persisted before this field existed -- never
  // below 1, since that's already the minimum scale that fully covers the
  // box with no letterboxing). Adjusted via VideoOverlayFramingDialog's own
  // Zoom slider; panX/panY still choose WHERE within the zoomed-in window
  // sits, over a correspondingly smaller range of slack -- see
  // computeCoverFitSourceRect below for how the two combine.
  zoom: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

export const DEFAULT_OVERLAY_FRAMING: OverlayFraming = { panX: 0.5, panY: 0.5, zoom: 1, flipHorizontal: false, flipVertical: false };

// An even split -- what every Split-Screen overlay starts with, and what a
// pre-`ratio` persisted layout (see the `?? DEFAULT_SPLIT_SCREEN_RATIO`
// fallback in computeOverlayRects below) is treated as having meant all
// along, since that's exactly what the old, un-adjustable 50/50 split was.
export const DEFAULT_SPLIT_SCREEN_RATIO = 0.5;

export interface VideoOverlayClip {
  assetId: string;
  startTimeSeconds: number;
  endTimeSeconds: number;
  // Offset INTO the source asset's own footage where playback starts --
  // fixed at 0 for v1 (no source-scrubbing/slip-trim UI yet). Part of the
  // schema now, not bolted on later, so a future slip-trim feature is a
  // pure UI addition with no breaking type change.
  sourceStartSeconds: number;
  layout: VideoOverlayLayout;
  framing: OverlayFraming;
  // 0 = only the base clip's own audio plays through this window (the
  // original behavior, and the default -- preserves every overlay added
  // before this field existed); 1 = only the overlay's own audio;
  // in between mixes both, each at that fraction of its own natural
  // volume (0.5 = both at half, not both at full -- avoids a jarring
  // double-loud mix, same reasoning a constant-power audio crossfade
  // uses). Adjusted via VideoOverlayAudioTrack.tsx's own draggable rail,
  // positioned above VideoOverlayTrack -- see CanvasPlayer.tsx for how
  // this is actually scheduled as gain automation during playback.
  audioBalance: number;
}

/** The single EXCLUSIVE-layout overlay (Full-Screen or Split-Screen) active
 * at `timeSeconds`, if any -- at most one can ever be active, since those
 * two layouts are mutually exclusive with each other. */
export function findActiveExclusiveOverlay(clips: VideoOverlayClip[], timeSeconds: number): VideoOverlayClip | null {
  return clips.find((c) => isExclusiveLayout(c.layout) && timeSeconds >= c.startTimeSeconds && timeSeconds < c.endTimeSeconds) ?? null;
}

/** Every Picture-in-Picture overlay active at `timeSeconds` -- unlike the
 * exclusive layouts, more than one CAN be visible at once. */
export function findActivePictureInPictureOverlays(clips: VideoOverlayClip[], timeSeconds: number): VideoOverlayClip[] {
  return clips.filter((c) => c.layout.type === "picture-in-picture" && timeSeconds >= c.startTimeSeconds && timeSeconds < c.endTimeSeconds);
}

// Short linear ramp (rather than a hard setValueAtTime step) for the main-
// track ducking and overlay-audio fade transitions below -- avoids an
// audible click/pop at a hard volume step. Shared by CanvasPlayer's live
// mixing graph and exportTimeline.ts's offline mix, so both fade at the same
// rate.
export const AUDIO_TRANSITION_RAMP_SECONDS = 0.03;

/** The base clip's own audio volume (0..1) over time, as a step function --
 * 1 everywhere by default, dipping to `1 - audioBalance` for the duration
 * of any overlay window that wants some of its own audio mixed in (see
 * VideoOverlayClip.audioBalance above), so the base track "ducks" rather
 * than playing at full volume underneath. Multiple Picture-in-Picture
 * overlays CAN be active at once with different balances -- the strongest
 * ducking request wins (`Math.max` of their balances), rather than
 * compounding. Hard cuts at each boundary (no fade) -- callers apply their
 * own short ramp (AUDIO_TRANSITION_RAMP_SECONDS above) around each
 * breakpoint instead. Breakpoints are returned in order, each holding until
 * the next one. All times here are in the ORIGINAL (pre-trim) sequence
 * timeline, same as VideoOverlayClip.startTimeSeconds/endTimeSeconds --
 * see RenderSegment's own doc comment on that convention, and
 * mapSourceRangeToOutputRanges below for translating a breakpoint interval
 * into its OUTPUT-time equivalent(s) for an offline render. */
export function computeMainAudioGainBreakpoints(
  overlays: VideoOverlayClip[],
  totalDurationSeconds: number
): { timeSeconds: number; gain: number }[] {
  const activeOverlays = overlays.filter((o) => o.audioBalance > 0);
  const points = new Set<number>([0, totalDurationSeconds]);
  for (const overlay of activeOverlays) {
    if (overlay.startTimeSeconds > 0 && overlay.startTimeSeconds < totalDurationSeconds) points.add(overlay.startTimeSeconds);
    if (overlay.endTimeSeconds > 0 && overlay.endTimeSeconds < totalDurationSeconds) points.add(overlay.endTimeSeconds);
  }
  const sorted = Array.from(points).sort((a, b) => a - b);

  return sorted.map((timeSeconds, index) => {
    // Sampled just after this breakpoint (the midpoint to the next one, or
    // the point itself for the last) to decide what's active starting HERE.
    const sampleAt = index < sorted.length - 1 ? (timeSeconds + sorted[index + 1]) / 2 : timeSeconds;
    const maxBalance = activeOverlays
      .filter((o) => sampleAt >= o.startTimeSeconds && sampleAt < o.endTimeSeconds)
      .reduce((max, o) => Math.max(max, o.audioBalance), 0);
    return { timeSeconds, gain: 1 - maxBalance };
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
 * `zoom` (>= 1, default 1 -- see OverlayFraming) crops in past the natural
 * cover fit: the sampled window's size shrinks by 1/zoom on both axes
 * (same aspect ratio throughout, so it still exactly covers the target box
 * once scaled up), and panX/panY then place that smaller window within the
 * FULL source's slack, same formula as the zoom=1 case -- this is exactly
 * why zoom=1 reproduces the original behavior unchanged. */
export function computeCoverFitSourceRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  panX: number = 0.5,
  panY: number = 0.5,
  zoom: number = 1
): { sx: number; sy: number; sWidth: number; sHeight: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return { sx: 0, sy: 0, sWidth: sourceWidth, sHeight: sourceHeight };
  }
  const clampedPanX = Math.min(Math.max(panX, 0), 1);
  const clampedPanY = Math.min(Math.max(panY, 0), 1);
  const clampedZoom = Math.max(zoom, 1);
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
  assetId: string;
  url: string;
  durationSeconds: number;
  startTimeSeconds: number;
  kind: "video" | "image";
}

export function buildSequenceClipInfos(
  clips: { assetId: string; url: string; durationSeconds: number; kind?: "video" | "image" }[]
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
 * asset animated via a Ken Burns template (lib/video/imageTemplates.ts),
 * which needs an authored `durationSeconds` (images have no intrinsic
 * duration) and a `templateId`. Every entry carries its own `id`, generated
 * once when it's added (see transformations.ts's applyAddSequenceClip/
 * applyAddImageSequenceClip) -- NOT the same as `assetId`, since the same
 * asset can appear more than once (two image clips from the same photo,
 * each with its own duration/template) and needs to be addressed
 * independently by everything downstream (thumbnail extraction, live
 * preview, the per-clip duration drag on FrameStrip).
 */
export type SequenceEntry =
  | { id: string; kind: "video"; assetId: string }
  | { id: string; kind: "image"; assetId: string; durationSeconds: number; templateId: string };

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
  /** Which kind of clip this segment came from -- determines whether the
   * compiler emits a Creatomate Video (with trimStart/trimDuration) or an
   * Image (no source trim, since a still image has no timeline of its own)
   * for it. See lib/timeline/compileCreatomateTimeline.ts. */
  kind: "video" | "image";
  sourceStartSeconds: number;
  /** This clip's own local offset where this segment begins -- Creatomate's Video.trimStart. */
  clipLocalStartSeconds: number;
  /** Also this segment's duration in OUTPUT time -- trimming removes stretches, it never changes playback speed. */
  durationSeconds: number;
  outputStartSeconds: number;
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

/**
 * Turns an ordered clip sequence + trim ranges into contiguous OUTPUT
 * segments. Splits every kept (post-trim) stretch further at each clip
 * boundary, so no segment ever spans more than one physical clip, even
 * when a trim cuts across the seam between two clips.
 */
export function buildRenderSegments(clips: SequenceClipInfo[], trimRanges: TrimRange[]): RenderSegment[] {
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

      segments.push({
        assetId: clip.assetId,
        kind: clip.kind,
        sourceStartSeconds: subStart,
        clipLocalStartSeconds: subStart - clip.startTimeSeconds,
        durationSeconds,
        outputStartSeconds: outputCursor,
      });
      outputCursor += durationSeconds;
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
