/**
 * Client-side frame extraction, powering the Playground's "unfold the video
 * into a timeline of per-second thumbnails" view (see
 * components/editor-v2/Playground.tsx).
 *
 * All numeric/layout math lives in video_math.ts -- this module only touches
 * the DOM (<video>, <canvas>). See audio.ts for the equivalent volume-graph
 * extraction over the audio track.
 *
 * Requires the R2 uploads bucket to have a CORS policy allowing this origin
 * (see backend/scripts/configure_r2_cors.py) -- without it, captureFrameAt
 * below throws a tainted-canvas SecurityError even though the same URL plays
 * fine in a plain <video> element (media playback is CORS-exempt; reading
 * pixels back out via canvas is not).
 */
import { generateSampleTimestamps } from "./video_math";

const THUMBNAIL_WIDTH_PX = 160;
const THUMBNAIL_JPEG_QUALITY = 0.7;

/** Loads `url` into a detached (never-appended-to-the-page) <video> element
 * and resolves once its metadata (duration, dimensions) is available. */
function loadVideoElement(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous"; // required for the canvas reads below to not taint
    video.preload = "auto";
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
        resolve(canvas.toDataURL("image/jpeg", THUMBNAIL_JPEG_QUALITY));
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

/**
 * Grabs a single representative frame from the video at `url` -- used by the
 * asset gallery's thumbnail tiles, which need one small preview per video
 * asset rather than the full per-second timeline strip. Reuses the same
 * load/capture primitives as extractThumbnails below. Defaults to 0.1s
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
export async function extractThumbnails(
  url: string,
  intervalSeconds: number,
  onProgress?: (framesSoFar: string[]) => void
): Promise<string[]> {
  const video = await loadVideoElement(url);
  try {
    const timestamps = generateSampleTimestamps(video.duration, intervalSeconds);

    const canvas = document.createElement("canvas");
    canvas.width = THUMBNAIL_WIDTH_PX;
    canvas.height = Math.round(THUMBNAIL_WIDTH_PX * (video.videoHeight / video.videoWidth || 9 / 16));

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
