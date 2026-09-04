/**
 * "Pulse with music" -- a subtle scale pulse tied to the project's
 * background-music amplitude. A drop-in sibling to camera3D.ts/
 * ambientEffects.ts: same "called identically from CanvasPlayer.tsx's live
 * preview and localRender/exportTimeline.ts's frame-accurate export" shape,
 * so both draw identical pixels with no drift. One fixed "cinematic"
 * amplitude, no exposed knobs, same philosophy as those two.
 *
 * Unlike camera3D/ambientEffect (pure functions of elapsed time alone),
 * this one needs real data -- the background track's own amplitude over
 * time -- so it's a two-step pipeline: `computeAudioEnvelope` distills a
 * decoded AudioBuffer into a small array ONCE (synchronous PCM math, no
 * Web Audio graph/AnalyserNode needed), then `sampleAudioEnvelopeAt` reads
 * it per frame. Both preview and export decode the exact same background
 * track and run the exact same deterministic math over it, which is what
 * keeps them in sync -- not any shared cache between the two.
 *
 * The background track always loops phase-locked to OUTPUT timeline time 0
 * (see CanvasPlayer.tsx's backgroundSource.start(0, adjustedOffsetSeconds %
 * backgroundBuffer.duration) and exportTimeline.ts's backgroundSource.start(0))
 * -- so callers must sample this with the same absolute output-timeline
 * time already in scope at each draw site (CanvasPlayer's `elapsedSeconds`,
 * exportTimeline's `outputTimeSeconds`), never a clip-local time.
 */

export interface AudioEnvelope {
  values: Float32Array;
  windowSeconds: number;
  durationSeconds: number;
}

const WINDOW_SECONDS = 1 / 30;
// Blend-toward-raw coefficients for the attack/release smoothing pass below
// -- snaps up fast on a transient, eases back down slower, so the result
// reads as a peak-meter "pump" rather than raw jittery RMS.
const ATTACK = 0.6;
const RELEASE = 0.15;
// Fixed "cinematic" pulse amplitude -- a 5% scale bump at full envelope
// value is visible without being disorienting, same "subtle, not pro-NLE"
// amplitude philosophy as camera3D.ts's MAX_PUSH_FRACTION.
const MAX_PULSE_SCALE = 0.05;

/** Distills a decoded background-music buffer into a small per-window RMS
 * envelope, normalized 0..1 against its own peak and smoothed with an
 * attack/release pass. Pure function of `buffer`'s PCM data -- same input
 * always produces the same output, which is the whole point (see this
 * file's own doc comment). */
export function computeAudioEnvelope(buffer: AudioBuffer): AudioEnvelope {
  const durationSeconds = buffer.duration;
  const windowFrames = Math.max(1, Math.round(WINDOW_SECONDS * buffer.sampleRate));
  const windowCount = Math.max(1, Math.ceil(buffer.length / windowFrames));
  const channelData: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    channelData.push(buffer.getChannelData(channel));
  }

  const raw = new Float32Array(windowCount);
  for (let window = 0; window < windowCount; window++) {
    const start = window * windowFrames;
    const end = Math.min(start + windowFrames, buffer.length);
    let sumSquares = 0;
    let sampleCount = 0;
    for (const data of channelData) {
      for (let i = start; i < end; i++) {
        sumSquares += data[i] * data[i];
        sampleCount++;
      }
    }
    raw[window] = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
  }

  const peak = raw.reduce((max, value) => Math.max(max, value), 0);
  const normalized = peak > 0 ? raw.map((value) => value / peak) : raw;

  const smoothed = new Float32Array(windowCount);
  let previous = 0;
  for (let window = 0; window < windowCount; window++) {
    const target = normalized[window];
    const coefficient = target > previous ? ATTACK : RELEASE;
    previous = previous + (target - previous) * coefficient;
    smoothed[window] = previous;
  }

  return { values: smoothed, windowSeconds: WINDOW_SECONDS, durationSeconds };
}

/** Samples an envelope at an absolute output-timeline time, looping it the
 * same way the background track itself loops (phase-locked to time 0), and
 * linearly interpolating between windows for a smooth pulse at any output
 * frame rate. Returns 0 for a missing envelope or a degenerate (silent/
 * zero-length) track -- a harmless no-op, same graceful-degradation style
 * as a clip with no active ZoomEffect for camera3D. */
export function sampleAudioEnvelopeAt(envelope: AudioEnvelope | null, timeSeconds: number): number {
  if (!envelope || envelope.durationSeconds <= 0 || envelope.values.length === 0) return 0;
  const phaseSeconds = ((timeSeconds % envelope.durationSeconds) + envelope.durationSeconds) % envelope.durationSeconds;
  const position = phaseSeconds / envelope.windowSeconds;
  const lowerIndex = Math.floor(position) % envelope.values.length;
  const upperIndex = (lowerIndex + 1) % envelope.values.length;
  const fraction = position - Math.floor(position);
  return envelope.values[lowerIndex] + (envelope.values[upperIndex] - envelope.values[lowerIndex]) * fraction;
}

/** Maps a normalized 0..1 envelope value to a scale multiplier around 1.0.
 * No exposed knobs -- one fixed amplitude, see MAX_PULSE_SCALE above. */
export function audioReactiveScale(envelopeValue: number): number {
  return 1 + envelopeValue * MAX_PULSE_SCALE;
}
