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
