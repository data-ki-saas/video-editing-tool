/**
 * Instant, client-side chroma-key cutout for a solid-color backdrop --
 * originally a literal green/blue screen, now any single solid color a
 * creator's footage was actually shot against (a white wall/backdrop, a
 * colored wall picked via CutawayDialog's eyedropper -- see
 * CHROMA_KEY_PRESETS' own comment). Used by BOTH a VideoOverlayClip and a
 * SequenceEntry (Cutaway) video/image clip -- the chroma-key counterpart to
 * backgroundSegmentation.ts's segmentClipFramesApproximate, same per-frame
 * ImageBitmap-in/alpha-mask-out shape (via that file's own
 * alphaMaskFromValues) so CanvasPlayer's compositing code doesn't need to
 * know which algorithm produced a given frame's mask.
 *
 * Used for BOTH live preview (chromaKeyFramesToAlphaMasks/chromaKeyImageToBitmap
 * below, against CanvasPlayer's pre-extracted preview frames) AND the actual
 * Edge Render output (applyChromaKeyAlpha below, against exportTimeline.ts's
 * real seeked frames via lib/video/video.ts's drawImageFlippedChromaKeyed) --
 * unlike "ai" mode's real fal.ai/VEED matting job, chroma key never talks to
 * any backend at all, by design: Edge Render is the free/local render path
 * and must not depend on a paid third-party API to produce its output. A
 * plain color-distance threshold has none of a real AI matting model's
 * edge/spill handling, so this is deliberately lower quality than "ai" mode
 * -- that's the tradeoff for a real solid-color backdrop never needing a
 * network round trip either to preview or to render.
 */
import { alphaMaskFromValues } from "./backgroundSegmentation";

export interface ChromaKeyPreset {
  label: string;
  hex: string;
}

// Three quick presets, not a full color picker for the common case -- a
// casual creator most often owns a green/blue screen OR shot against a
// plain white wall/backdrop/lightbox (a product photo, a portrait against a
// blank wall), matching this app's driving-vision preference for simple
// controls over exposing every knob. A photo shot against some OTHER solid
// color (a colored wall, a tinted backdrop) is why "Pick from photo" exists
// alongside these -- see CutawayDialog.tsx's eyedropper, which samples the
// actual background pixel the creator taps rather than asking them to name
// or type its color. Still no tolerance slider -- KEY_DISTANCE_LOW/HIGH
// below stay fixed either way.
export const CHROMA_KEY_PRESETS: ChromaKeyPreset[] = [
  { label: "Green screen", hex: "#00b140" },
  { label: "Blue screen", hex: "#0047ab" },
  { label: "White backdrop", hex: "#ffffff" },
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

// The inverse of hexToRgb -- used by CutawayDialog's/VideoOverlayPickerDialog's
// eyedropper to turn a sampled photo pixel back into the hex string
// chromaKeyColor is persisted as.
export function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (channel: number) => channel.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
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

/** The Ken Burns (still-photo) counterpart to chromaKeyFramesToAlphaMasks --
 * one image in, one RGBA cutout out (original colors preserved, alpha keyed
 * from `keyColorHex`), the same shape backgroundSegmentation.ts's
 * segmentImageApproximate returns for its AI-approximate cutout. Used by
 * CutawayDialog's own live preview and CanvasPlayer's image-clip loader when
 * a cutaway's backgroundRemoval.mode is "chromaKey" -- unlike AI mode, there
 * is no separate matte asset to wait on, so this always returns the final
 * result immediately, live, at add-time or render-time alike. */
export async function chromaKeyImageToBitmap(image: HTMLImageElement | ImageBitmap, keyColorHex: string): Promise<ImageBitmap> {
  const width = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
  const height = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return createImageBitmap(image);

  ctx.drawImage(image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  applyChromaKeyAlpha(imageData, hexToRgb(keyColorHex));
  return createImageBitmap(imageData);
}
