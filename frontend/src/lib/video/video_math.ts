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
 */
export interface SequenceClipInfo {
  assetId: string;
  url: string;
  durationSeconds: number;
  startTimeSeconds: number;
}

export function buildSequenceClipInfos(
  clips: { assetId: string; url: string; durationSeconds: number }[]
): SequenceClipInfo[] {
  let cursor = 0;
  return clips.map((clip) => {
    const info: SequenceClipInfo = { ...clip, startTimeSeconds: cursor };
    cursor += clip.durationSeconds;
    return info;
  });
}

export function totalSequenceDuration(clips: SequenceClipInfo[]): number {
  return clips.reduce((sum, clip) => sum + clip.durationSeconds, 0);
}

// Keeps background music audible under the main clip's own audio without
// drowning it out -- no volume control exposed for it (v1), matching this
// app's "smart default over exposing every knob" bias. Shared between
// CanvasPlayer.tsx's live preview and lib/localRender/exportTimeline.ts's
// offline mix so the two never drift out of sync independently (see also
// compileCreatomateTimeline.ts's BACKGROUND_MUSIC_VOLUME_PERCENT, which
// mirrors this same value for the Creatomate render).
export const BACKGROUND_MUSIC_GAIN = 0.5;

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
): { outputStartSeconds: number; outputEndSeconds: number }[] {
  const ranges: { outputStartSeconds: number; outputEndSeconds: number }[] = [];
  for (const segment of segments) {
    const segmentSourceEnd = segment.sourceStartSeconds + segment.durationSeconds;
    const overlapStart = Math.max(sourceStartSeconds, segment.sourceStartSeconds);
    const overlapEnd = Math.min(sourceEndSeconds, segmentSourceEnd);
    if (overlapEnd <= overlapStart) continue;

    ranges.push({
      outputStartSeconds: segment.outputStartSeconds + (overlapStart - segment.sourceStartSeconds),
      outputEndSeconds: segment.outputStartSeconds + (overlapEnd - segment.sourceStartSeconds),
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
