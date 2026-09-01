/**
 * Client-side frame extraction. Two callers use this:
 *  - the Playground's per-second thumbnail strip (extractThumbnails)
 *  - CanvasPlayer's preview-playback frames (extractPreviewFrames), at a
 *    device/duration-adapted rate from video_math.ts's pickPreviewFrameRate
 *
 * All numeric/layout math lives in video_math.ts -- this module only touches
 * the DOM (<video>, <canvas>). See audio.ts for the equivalent audio-track
 * handling (volume graph + playback decode).
 *
 * Requires the R2 uploads bucket to have a CORS policy allowing this origin
 * (see backend/scripts/configure_r2_cors.py) -- without it, captureFrameAt
 * below throws a tainted-canvas SecurityError even though the same URL plays
 * fine in a plain <video> element (media playback is CORS-exempt; reading
 * pixels back out via canvas is not).
 */
import { generateSampleTimestamps } from "./video_math";
import { applyChromaKeyAlpha } from "./chromaKey";

const THUMBNAIL_WIDTH_PX = 160;
const PREVIEW_FRAME_WIDTH_PX = 480;
const FRAME_JPEG_QUALITY = 0.7;

/** Loads `url` into a detached (never-appended-to-the-page) <video> element
 * and resolves once its metadata (duration, dimensions) is available.
 * `preload: "metadata"` is used for duration-only probes (getVideoDuration)
 * to avoid buffering the whole file when only the header is needed. Exported
 * for lib/localRender/exportTimeline.ts, which needs a real seekable <video>
 * per clip (not the capped preview frames extractPreviewFrames produces) to
 * source full-quality frames during an offline export. */
export function loadVideoElement(url: string, preload: "metadata" | "auto" = "auto"): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous"; // required for the canvas reads below to not taint
    video.preload = preload;
    video.muted = true;
    video.src = url;
    video.onloadedmetadata = () => resolve(video);
    video.onerror = () => {
      reject(new Error(`Could not load video for frame extraction: ${video.error?.message ?? "unknown error"}`));
    };
  });
}

/** Seeks `video` to `timeSeconds`, draws the resulting frame into `canvas`,
 * and returns it as a JPEG data URL. Sequential by design -- HTMLVideoElement
 * only supports one pending seek at a time, so callers must await each frame
 * before requesting the next. */
function captureFrameAt(video: HTMLVideoElement, timeSeconds: number, canvas: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    function onSeeked() {
      video.removeEventListener("seeked", onSeeked);
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas 2D context unavailable"));
        return;
      }
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", FRAME_JPEG_QUALITY));
      } catch (err) {
        // Most likely a tainted-canvas SecurityError -- see this module's
        // top comment about the R2 bucket's CORS policy.
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    video.addEventListener("seeked", onSeeked);
    video.currentTime = timeSeconds;
  });
}

// Below this, "seeked" simply won't fire (the browser considers the video
// already there) -- seekVideoTo resolves immediately instead of waiting
// forever on an event that was never coming.
const SEEK_NOOP_EPSILON_SECONDS = 1 / 120;

/** Seeks `video` to `timeSeconds` and resolves once the frame there is
 * actually decoded -- the same seek-and-wait `video` uses internally, but
 * exposed on its own (no canvas draw) for lib/localRender/exportTimeline.ts,
 * which needs to seek a real <video> per output frame and then composite it
 * itself (crop/flip/overlays/text), not just grab a plain full-frame JPEG. */
export function seekVideoTo(video: HTMLVideoElement, timeSeconds: number): Promise<void> {
  if (Math.abs(video.currentTime - timeSeconds) < SEEK_NOOP_EPSILON_SECONDS) return Promise.resolve();
  return new Promise((resolve) => {
    function onSeeked() {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    }
    video.addEventListener("seeked", onSeeked);
    video.currentTime = timeSeconds;
  });
}

/** Draws `source`'s [sx,sy,sWidth,sHeight] source region into
 * [destX,destY,destWidth,destHeight], optionally mirrored horizontally/
 * vertically WITHIN that destination box only -- e.g. a video overlay's own
 * flip/mirror (see video_math.ts's OverlayFraming), which only ever mirrors
 * its own box, unlike the base clip's whole-canvas flip transform. Shared by
 * CanvasPlayer's live preview and exportTimeline.ts's offline export, both
 * of which composite video overlays this same way -- `source` is an
 * HTMLVideoElement in the export path (real per-frame seeks) and an
 * HTMLImageElement in the preview path (pre-extracted preview frames). */
export function drawImageFlipped(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sWidth: number,
  sHeight: number,
  destX: number,
  destY: number,
  destWidth: number,
  destHeight: number,
  flipHorizontal: boolean,
  flipVertical: boolean
) {
  ctx.save();
  ctx.translate(flipHorizontal ? destX + destWidth : destX, flipVertical ? destY + destHeight : destY);
  ctx.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
  ctx.drawImage(source, sx, sy, sWidth, sHeight, 0, 0, destWidth, destHeight);
  ctx.restore();
}

/** Same composite as drawImageFlipped above, but keys `source` down to
 * `matte`'s alpha first via a scratch canvas -- the video-overlay
 * equivalent of CanvasPlayer's own base-clip "destination-in" masked
 * composite (see its drawFrameAt), generalized to a caller-supplied dest
 * rect/flip instead of the base clip's own crop rect, so it works for a
 * Full-Screen OR Picture-in-Picture overlay box alike. `source` and `matte`
 * are drawn through the IDENTICAL flip transform (each wrapped in its own
 * save/translate/scale/restore) so the cutout still lines up pixel-for-pixel
 * with its mask even when mirrored -- `matte`'s own pixel dimensions need
 * not match `source`'s; matteSx/Sy/SWidth/SHeight are computed by the
 * caller from PROPORTIONAL source coordinates against matte.width/height
 * (mirroring the base-clip path's own crop-fraction-of-matte-dimensions
 * approach), not assumed identical. `maskCanvas` is a scratch canvas the
 * SAME size as the real canvas -- reused across frames by the caller rather
 * than reallocated here. */
export function drawImageFlippedMasked(
  ctx: CanvasRenderingContext2D,
  maskCanvas: HTMLCanvasElement,
  source: CanvasImageSource,
  matte: CanvasImageSource,
  sx: number,
  sy: number,
  sWidth: number,
  sHeight: number,
  matteSx: number,
  matteSy: number,
  matteSWidth: number,
  matteSHeight: number,
  destX: number,
  destY: number,
  destWidth: number,
  destHeight: number,
  flipHorizontal: boolean,
  flipVertical: boolean
) {
  const maskCtx = maskCanvas.getContext("2d");
  if (!maskCtx) return;
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);

  maskCtx.globalCompositeOperation = "source-over";
  maskCtx.save();
  maskCtx.translate(flipHorizontal ? destX + destWidth : destX, flipVertical ? destY + destHeight : destY);
  maskCtx.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
  maskCtx.drawImage(source, sx, sy, sWidth, sHeight, 0, 0, destWidth, destHeight);
  maskCtx.restore();

  maskCtx.globalCompositeOperation = "destination-in";
  maskCtx.save();
  maskCtx.translate(flipHorizontal ? destX + destWidth : destX, flipVertical ? destY + destHeight : destY);
  maskCtx.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
  maskCtx.drawImage(matte, matteSx, matteSy, matteSWidth, matteSHeight, 0, 0, destWidth, destHeight);
  maskCtx.restore();

  maskCtx.globalCompositeOperation = "source-over";
  ctx.drawImage(maskCanvas, 0, 0);
}

/** The chroma-key counterpart to drawImageFlippedMasked above -- for a video
 * overlay in "chromaKey" mode, exportTimeline.ts's actual Edge Render
 * output, not just CanvasPlayer's preview (see chromaKey.ts's own module
 * comment on why chroma key never depends on a real fal.ai matte at all).
 * Unlike the two-source "destination-in" trick above, there's only ONE
 * draw here: `source`'s own pixels, once drawn, already carry everything
 * needed to key it out (its own colors), so lib/video/chromaKey.ts's
 * applyChromaKeyAlpha mutates that same drawn region's alpha in place
 * instead of compositing a second source. `keyColor` is pre-parsed by the
 * caller (chromaKey.ts's hexToRgb) rather than a hex string, so a per-frame
 * export loop doesn't reparse it every call. */
export function drawImageFlippedChromaKeyed(
  ctx: CanvasRenderingContext2D,
  maskCanvas: HTMLCanvasElement,
  source: CanvasImageSource,
  keyColor: { r: number; g: number; b: number },
  sx: number,
  sy: number,
  sWidth: number,
  sHeight: number,
  destX: number,
  destY: number,
  destWidth: number,
  destHeight: number,
  flipHorizontal: boolean,
  flipVertical: boolean
) {
  const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
  if (!maskCtx) return;
  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);

  maskCtx.save();
  maskCtx.translate(flipHorizontal ? destX + destWidth : destX, flipVertical ? destY + destHeight : destY);
  maskCtx.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
  maskCtx.drawImage(source, sx, sy, sWidth, sHeight, 0, 0, destWidth, destHeight);
  maskCtx.restore();

  // Clamped to maskCanvas's own bounds -- destX/destY/destWidth/destHeight
  // are trusted caller-computed rects, but a getImageData call with an
  // out-of-bounds region throws rather than clamping itself.
  const left = Math.max(0, Math.floor(destX));
  const top = Math.max(0, Math.floor(destY));
  const right = Math.min(maskCanvas.width, Math.ceil(destX + destWidth));
  const bottom = Math.min(maskCanvas.height, Math.ceil(destY + destHeight));
  const regionWidth = right - left;
  const regionHeight = bottom - top;
  if (regionWidth > 0 && regionHeight > 0) {
    const imageData = maskCtx.getImageData(left, top, regionWidth, regionHeight);
    applyChromaKeyAlpha(imageData, keyColor);
    maskCtx.putImageData(imageData, left, top);
  }

  ctx.drawImage(maskCanvas, 0, 0);
}

/** Extracts frames at a fixed interval, at a given thumbnail width, sharing
 * the load/seek/capture machinery between extractThumbnails and
 * extractPreviewFrames below (they only differ in interval and size). */
async function extractFramesAtInterval(
  url: string,
  intervalSeconds: number,
  widthPx: number,
  onProgress?: (framesSoFar: string[]) => void
): Promise<string[]> {
  const video = await loadVideoElement(url);
  try {
    const timestamps = generateSampleTimestamps(video.duration, intervalSeconds);

    const canvas = document.createElement("canvas");
    canvas.width = widthPx;
    canvas.height = Math.round(widthPx * (video.videoHeight / video.videoWidth || 9 / 16));

    const frames: string[] = [];
    for (const timestamp of timestamps) {
      frames.push(await captureFrameAt(video, timestamp, canvas));
      onProgress?.([...frames]);
    }
    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

/** Duration-only probe -- used by CanvasPlayer to pick a preview frame rate
 * (video_math.ts's pickPreviewFrameRate) before committing to a full
 * extraction pass at that rate. */
export async function getVideoDuration(url: string): Promise<number> {
  const video = await loadVideoElement(url, "metadata");
  const duration = video.duration;
  video.removeAttribute("src");
  video.load();
  return duration;
}

/** Same probe as getVideoDuration, also returning the file's own real
 * pixel dimensions -- needed by gatherLocalRenderClips.ts/gatherRenderClips.ts
 * so a render can re-project the sequence's authored crop rect onto each
 * clip's own aspect ratio (video_math.ts's reprojectCropRect) instead of
 * reusing it verbatim against a differently-shaped clip. */
export async function getVideoDurationAndDimensions(url: string): Promise<{ durationSeconds: number; width: number; height: number }> {
  const video = await loadVideoElement(url, "metadata");
  const result = { durationSeconds: video.duration, width: video.videoWidth, height: video.videoHeight };
  video.removeAttribute("src");
  video.load();
  return result;
}

/**
 * Grabs a single representative frame from the video at `url` -- used by the
 * asset gallery's thumbnail tiles, which need one small preview per video
 * asset rather than the full per-second timeline strip. Defaults to 0.1s
 * rather than 0 since the very first frame of some encodings is black.
 */
export async function captureSingleFrame(url: string, atSeconds = 0.1): Promise<string> {
  const video = await loadVideoElement(url);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = THUMBNAIL_WIDTH_PX;
    canvas.height = Math.round(THUMBNAIL_WIDTH_PX * (video.videoHeight / video.videoWidth || 9 / 16));
    const clampedTime = Math.min(atSeconds, video.duration || atSeconds);
    return await captureFrameAt(video, clampedTime, canvas);
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

/**
 * Extracts one thumbnail per `intervalSeconds` across the full duration of
 * the video at `url`. Calls `onProgress` with the frames captured so far
 * after each one, so the Playground can render the strip incrementally
 * instead of waiting for a multi-minute video to finish extracting entirely.
 */
export function extractThumbnails(
  url: string,
  intervalSeconds: number,
  onProgress?: (framesSoFar: string[]) => void
): Promise<string[]> {
  return extractFramesAtInterval(url, intervalSeconds, THUMBNAIL_WIDTH_PX, onProgress);
}

/** Seeks `video` to `timeSeconds` and grabs the resulting frame straight into
 * a resized ImageBitmap -- no canvas draw, no toDataURL JPEG encode, no
 * re-decoding a data URI back into an <img> afterwards (that's what
 * captureFrameAt above does, since it needs a displayable string for
 * FrameStrip's <img> tags). extractPreviewFrames below only ever feeds these
 * into ctx.drawImage on CanvasPlayer's own canvas, which accepts an
 * ImageBitmap directly, so skipping that whole encode/decode round trip is
 * free correctness-wise and meaningfully cuts per-frame extraction time. */
function captureFrameBitmapAt(video: HTMLVideoElement, timeSeconds: number, widthPx: number, heightPx: number): Promise<ImageBitmap> {
  return new Promise((resolve, reject) => {
    function onSeeked() {
      video.removeEventListener("seeked", onSeeked);
      createImageBitmap(video, { resizeWidth: widthPx, resizeHeight: heightPx, resizeQuality: "medium" })
        .then(resolve)
        .catch((err) => reject(err instanceof Error ? err : new Error(String(err))));
    }
    video.addEventListener("seeked", onSeeked);
    video.currentTime = timeSeconds;
  });
}

/**
 * Extracts frames at `frameRate` (see video_math.ts's pickPreviewFrameRate
 * for how CanvasPlayer picks this) across the full duration of the video at
 * `url`, at a size suited to actual playback rather than a small thumbnail.
 * Returns ImageBitmaps rather than the data-URL strings extractThumbnails
 * produces -- see captureFrameBitmapAt above for why. `onProgress` reports
 * (framesExtractedSoFar, totalFrameCount) after each frame so a caller can
 * show a percentage while a long clip is still extracting.
 */
export async function extractPreviewFrames(
  url: string,
  frameRate: number,
  onProgress?: (framesExtractedSoFar: number, totalFrameCount: number) => void
): Promise<ImageBitmap[]> {
  const video = await loadVideoElement(url);
  try {
    const timestamps = generateSampleTimestamps(video.duration, 1 / frameRate);
    const heightPx = Math.round(PREVIEW_FRAME_WIDTH_PX * (video.videoHeight / video.videoWidth || 9 / 16));

    const bitmaps: ImageBitmap[] = [];
    for (const timestamp of timestamps) {
      bitmaps.push(await captureFrameBitmapAt(video, timestamp, PREVIEW_FRAME_WIDTH_PX, heightPx));
      onProgress?.(bitmaps.length, timestamps.length);
    }
    return bitmaps;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}
