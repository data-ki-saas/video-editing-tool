/**
 * Instant, client-side chroma-key cutout for a solid-color (green/blue
 * screen) video overlay -- the chroma-key counterpart to
 * backgroundSegmentation.ts's segmentClipFramesApproximate, same per-frame
 * ImageBitmap-in/alpha-mask-out shape (via that file's own
 * alphaMaskFromValues) so CanvasPlayer's compositing code doesn't need to
 * know which algorithm produced a given frame's mask.
 *
 * Used for BOTH live preview (chromaKeyFramesToAlphaMasks below, against
 * CanvasPlayer's pre-extracted preview frames) AND the actual Edge Render
 * output (applyChromaKeyAlpha below, against exportTimeline.ts's real seeked
 * frames via lib/video/video.ts's drawImageFlippedChromaKeyed) -- unlike
 * "ai" mode's real fal.ai/VEED matting job, chroma key never talks to any
 * backend at all, by design: Edge Render is the free/local render path and
 * must not depend on a paid third-party API to produce its output. A plain
 * color-distance threshold has none of a real AI matting model's edge/spill
 * handling, so this is deliberately lower quality than "ai" mode -- that's
 * the tradeoff for a real green/blue screen never needing a network round
 * trip either to preview or to render.
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

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
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

/** Mutates `imageData`'s own alpha channel in place from its RGB distance to
 * `key` -- the single-frame core this file's two consumers both key off of:
 * chromaKeyFramesToAlphaMasks below (preview, building a standalone mask
 * bitmap per pre-extracted frame) and video.ts's drawImageFlippedChromaKeyed
 * (Edge Render, mutating the exact pixels already drawn for a real seeked
 * output frame, no separate mask bitmap needed there). RGB is left
 * untouched -- harmless, since every caller only ever composites this
 * through a "destination-in"-style operation that reads alpha alone. */
export function applyChromaKeyAlpha(imageData: ImageData, key: { r: number; g: number; b: number }): void {
  const { data } = imageData;
  for (let i = 0; i < data.length; i += 4) {
    const distance =
      Math.sqrt((data[i] - key.r) ** 2 + (data[i + 1] - key.g) ** 2 + (data[i + 2] - key.b) ** 2) / MAX_RGB_DISTANCE;
    data[i + 3] = Math.round(data[i + 3] * smoothstep(KEY_DISTANCE_LOW, KEY_DISTANCE_HIGH, distance));
  }
}

export async function chromaKeyFramesToAlphaMasks(frames: ImageBitmap[], keyColorHex: string): Promise<ImageBitmap[]> {
  const key = hexToRgb(keyColorHex);
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
    const imageData = ctx.getImageData(0, 0, frame.width, frame.height);
    applyChromaKeyAlpha(imageData, key);
    masks.push(await createImageBitmap(imageData));
  }
  return masks;
}
