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
