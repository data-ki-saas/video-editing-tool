/**
 * Instant, client-side chroma-key cutout for a solid-color (green/blue
 * screen) video overlay -- the chroma-key counterpart to
 * backgroundSegmentation.ts's segmentClipFramesApproximate, same per-frame
 * ImageBitmap-in/alpha-mask-out shape (via that file's own
 * alphaMaskFromValues) so CanvasPlayer's compositing code doesn't need to
 * know which algorithm produced a given frame's mask.
 *
 * PREVIEW ONLY. A plain color-distance threshold has none of a real AI
 * matting model's edge/spill handling, so this is never used for the actual
 * rendered/exported video -- the final render always goes through fal.ai
 * instead (see ThreePaneEditor.tsx's resolveChromaKeyOverlayMattesForRender),
 * exactly mirroring how CanvasPlayer's own MediaPipe approximation for "ai"
 * mode is preview-only there too (exportTimeline.ts's own module comment:
 * "final render only trusts a real matte").
 */
import { alphaMaskFromValues } from "./backgroundSegmentation";

export interface ChromaKeyPreset {
  label: string;
  hex: string;
}

// Two presets, not a free-form color picker -- a casual creator picks
// "green" or "blue" (the two screens they'd actually own), matching this
// app's driving-vision preference for simple controls over exposing every
// knob (no custom-color input, no tolerance slider).
export const CHROMA_KEY_PRESETS: ChromaKeyPreset[] = [
  { label: "Green screen", hex: "#00b140" },
  { label: "Blue screen", hex: "#0047ab" },
];
export const DEFAULT_CHROMA_KEY_COLOR = CHROMA_KEY_PRESETS[0].hex;

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace("#", "");
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((c) => c + c)
          .join("")
      : normalized;
  const value = parseInt(expanded, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

// How far a pixel's color must be from the key color, as a fraction of the
// maximum possible RGB distance (0..1), before it counts as "subject" --
// fixed rather than a user-facing tolerance slider, same "smart default
// over exposing a knob" reasoning CHROMA_KEY_PRESETS' own comment gives.
// Below KEY_DISTANCE_LOW: fully transparent (background). Above
// KEY_DISTANCE_HIGH: fully opaque (subject). In between: a smoothstep ramp
// for a soft, non-aliased edge.
const KEY_DISTANCE_LOW = 0.16;
const KEY_DISTANCE_HIGH = 0.4;
const MAX_RGB_DISTANCE = 255 * Math.sqrt(3);

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

export async function chromaKeyFramesToAlphaMasks(frames: ImageBitmap[], keyColorHex: string): Promise<ImageBitmap[]> {
  const { r: kr, g: kg, b: kb } = hexToRgb(keyColorHex);
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    // Same "fails toward looks normal" fallback as backgroundSegmentation.ts's
    // own fullyOpaqueMask -- a fully-opaque mask draws as a normal,
    // un-keyed frame rather than vanishing.
    return Promise.all(
      frames.map((frame) => alphaMaskFromValues(new Float32Array(frame.width * frame.height).fill(1), frame.width, frame.height, 1))
    );
  }

  const masks: ImageBitmap[] = [];
  for (const frame of frames) {
    canvas.width = frame.width;
    canvas.height = frame.height;
    ctx.drawImage(frame, 0, 0);
    const { data } = ctx.getImageData(0, 0, frame.width, frame.height);
    const alpha = new Float32Array(frame.width * frame.height);
    for (let i = 0; i < alpha.length; i++) {
      const offset = i * 4;
      const distance =
        Math.sqrt((data[offset] - kr) ** 2 + (data[offset + 1] - kg) ** 2 + (data[offset + 2] - kb) ** 2) / MAX_RGB_DISTANCE;
      alpha[i] = smoothstep(KEY_DISTANCE_LOW, KEY_DISTANCE_HIGH, distance);
    }
    masks.push(await alphaMaskFromValues(alpha, frame.width, frame.height, 1));
  }
  return masks;
}
