/**
 * Client-side helpers that turn a clip's own frames into a per-frame alpha
 * mask CanvasPlayer can composite with (see its own drawFrameAt, the
 * "destination-in" masked-foreground path) -- two sources, matching this
 * feature's own plan doc's two-stage live preview:
 *
 *  - segmentClipFramesApproximate: an INSTANT, rough cutout via MediaPipe's
 *    selfie-segmentation model, run directly in the browser the moment
 *    CutawayDialog's "Remove background" toggle is flipped -- no server
 *    round-trip, good enough for immediate visual feedback while VEED's
 *    real matting job (backend/src/matting/) is still processing.
 *  - lumaFramesToAlphaMasks: converts the REAL matte VEED eventually returns
 *    (a grayscale luma video, extracted the same way any other clip's
 *    frames are via extractPreviewFrames) into the identical alpha-mask
 *    shape, so CanvasPlayer's compositing code doesn't care which source
 *    produced a given frame's mask.
 *  - segmentImageApproximate: the Ken Burns (still-photo) equivalent of
 *    segmentClipFramesApproximate -- one image in, one RGBA cutout out
 *    (colors preserved, alpha from the same MediaPipe model), standing in
 *    for rembg's real cutout the same way the video helper stands in for
 *    VEED's real matte.
 *
 * Both return ImageBitmaps whose ALPHA channel carries the mask value (0 =
 * background, 255 = subject) -- their RGB is irrelevant and never read,
 * since `ctx.globalCompositeOperation = "destination-in"` (Porter-Duff
 * "DestIn") only consults the SOURCE's alpha, keeping the destination's own
 * color scaled by it. This is the client-side equivalent of Creatomate's
 * real maskMode: "luma" (see compileCreatomateTimeline.ts's
 * buildBackgroundRemovedSegment) -- not the same algorithm, but the same
 * "alpha channel IS the mask" contract on both sides, which is what lets
 * the live preview and the real render agree on where the cutout line is.
 */
import { ImageSegmenter, FilesetResolver } from "@mediapipe/tasks-vision";

// Pinned to the exact installed @mediapipe/tasks-vision version (see
// package.json) -- the WASM binaries must match the JS bindings' own
// expected ABI. NOT verified against a live browser run (no environment
// available to actually load a webcam/canvas frame through this while
// wiring it up) -- confirm before relying on it in production:
//  1. That confidenceMasks[0] really is a FOREGROUND/person probability
//     (not background-probability, which would need `1 - value` instead
//     of using it directly below).
//  2. That this model URL is still live and CORS-accessible from a browser
//     (Google's own hosted MediaPipe model bucket, not this app's own
//     infra) -- if it 404s/CORS-fails, getSegmenter's promise rejects and
//     every caller below falls back to "no mask" (see its own try/catch).
const WASM_BASE_PATH = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_ASSET_PATH =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

let segmenterPromise: Promise<ImageSegmenter> | null = null;

function getSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    // CPU delegate, not GPU -- this only ever runs against a capped,
    // device-adapted frame COUNT (the same pickPreviewFrameRate budget
    // extractPreviewFrames already uses for normal playback frames, see
    // video.ts), not full video frame rate, so the reliability of "always
    // works, no WebGL context requirements" matters more here than raw
    // speed.
    segmenterPromise = FilesetResolver.forVisionTasks(WASM_BASE_PATH).then((fileset) =>
      ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_ASSET_PATH, delegate: "CPU" },
        runningMode: "VIDEO",
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      })
    );
  }
  return segmenterPromise;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// Exported for lib/video/chromaKey.ts -- same "an array of 0..1-scaled
// values IN, an alpha-carrying ImageBitmap OUT" contract, just fed by a
// color-distance computation instead of a segmentation model.
export async function alphaMaskFromValues(values: Float32Array | Uint8Array, width: number, height: number, scale: number): Promise<ImageBitmap> {
  const imageData = new ImageData(width, height);
  for (let i = 0; i < values.length; i++) {
    const alpha = Math.round(clamp01(values[i] * scale) * 255);
    const offset = i * 4;
    // RGB is never read by the "destination-in" composite this feeds --
    // only alpha matters (see this file's own module comment).
    imageData.data[offset] = 255;
    imageData.data[offset + 1] = 255;
    imageData.data[offset + 2] = 255;
    imageData.data[offset + 3] = alpha;
  }
  return createImageBitmap(imageData);
}

/** A fully-opaque alpha mask (every pixel = subject) -- the safe fallback
 * when segmentation genuinely can't run (model failed to load, a frame
 * segmentation call threw) so a caller can still composite against SOME
 * mask rather than branching its whole draw path on "mask may be absent
 * for this one frame but present for its neighbors". Visually this means
 * "no cutout happened yet" (the clip draws as a normal full-frame video)
 * rather than the frame vanishing entirely -- fails toward "looks normal",
 * not toward "looks broken". */
function fullyOpaqueMask(width: number, height: number): Promise<ImageBitmap> {
  return alphaMaskFromValues(new Float32Array(width * height).fill(1), width, height, 1);
}

export async function segmentClipFramesApproximate(frames: ImageBitmap[]): Promise<ImageBitmap[]> {
  let segmenter: ImageSegmenter;
  try {
    segmenter = await getSegmenter();
  } catch (err) {
    console.error("[backgroundSegmentation] failed to load MediaPipe selfie segmenter", err);
    return Promise.all(frames.map((frame) => fullyOpaqueMask(frame.width, frame.height)));
  }

  const masks: ImageBitmap[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    try {
      // `i * 33` -- a monotonically increasing millisecond timestamp is all
      // VIDEO running mode requires (~30fps spacing); these frames aren't
      // actually played at a fixed rate (extractPreviewFrames samples at
      // pickPreviewFrameRate, which varies), but the segmenter only uses
      // this to reject a NON-increasing timestamp, not to time anything.
      const result = segmenter.segmentForVideo(frame, i * 33);
      const mask = result.confidenceMasks?.[0];
      if (!mask) {
        masks.push(await fullyOpaqueMask(frame.width, frame.height));
        continue;
      }
      masks.push(await alphaMaskFromValues(mask.getAsFloat32Array(), mask.width, mask.height, 1));
      mask.close();
    } catch (err) {
      console.error("[backgroundSegmentation] segmentForVideo failed for frame %d", i, err);
      masks.push(await fullyOpaqueMask(frame.width, frame.height));
    }
  }
  return masks;
}

/** Instant, client-side approximate cutout for a Ken Burns (still-image)
 * cutaway's live preview, while the photo's own background-removal job
 * (backend/src/matting/service.py's image-kind path, via rembg) is still in
 * flight -- unlike the video helpers above, this returns a full RGBA
 * ImageBitmap with the ORIGINAL photo's own colors preserved and alpha set
 * from MediaPipe's confidence mask, not a bare alpha carrier. CanvasPlayer
 * draws this directly in place of the original photo once a backdrop is
 * already drawn beneath it -- no separate "destination-in" masking step
 * needed, since (like the real rembg cutout it's standing in for) this
 * image's own transparency already IS the mask, the same way a real PNG
 * cutout's alpha channel works natively in any 2D canvas draw. */
export async function segmentImageApproximate(image: HTMLImageElement | ImageBitmap): Promise<ImageBitmap> {
  const width = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
  const height = image instanceof HTMLImageElement ? image.naturalHeight : image.height;

  let segmenter: ImageSegmenter;
  try {
    segmenter = await getSegmenter();
  } catch (err) {
    console.error("[backgroundSegmentation] failed to load MediaPipe selfie segmenter", err);
    return createImageBitmap(image);
  }

  try {
    const bitmap = image instanceof ImageBitmap ? image : await createImageBitmap(image);
    // Running mode is "VIDEO" (see getSegmenter) -- a single still photo is
    // just a one-frame "video" as far as the segmenter cares, same
    // reasoning segmentClipFramesApproximate's own per-frame calls rely on;
    // timestamp 0 is fine since nothing else ever calls segmentForVideo on
    // this same segmenter instance concurrently with a lower timestamp.
    const result = segmenter.segmentForVideo(bitmap, 0);
    const mask = result.confidenceMasks?.[0];
    if (!mask) return bitmap;

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return bitmap;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);

    const values = mask.getAsFloat32Array();
    const maskWidth = mask.width;
    const maskHeight = mask.height;
    mask.close();
    // The mask's own resolution isn't guaranteed to match the photo's --
    // nearest-neighbor sample rather than requiring an exact match, same
    // "scaling handled independently" reasoning CanvasPlayer's own
    // matteSx/matteSy (drawImage-based scaling) uses for the video path,
    // just done manually here since this is a per-pixel alpha write, not a
    // drawImage call.
    for (let y = 0; y < height; y++) {
      const my = Math.min(maskHeight - 1, Math.floor((y / height) * maskHeight));
      for (let x = 0; x < width; x++) {
        const mx = Math.min(maskWidth - 1, Math.floor((x / width) * maskWidth));
        imageData.data[(y * width + x) * 4 + 3] = Math.round(clamp01(values[my * maskWidth + mx]) * 255);
      }
    }
    return createImageBitmap(imageData);
  } catch (err) {
    console.error("[backgroundSegmentation] segmentForVideo failed for image", err);
    return createImageBitmap(image);
  }
}

export async function lumaFramesToAlphaMasks(frames: ImageBitmap[]): Promise<ImageBitmap[]> {
  const canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return Promise.all(frames.map((frame) => fullyOpaqueMask(frame.width, frame.height)));

  const masks: ImageBitmap[] = [];
  for (const frame of frames) {
    canvas.width = frame.width;
    canvas.height = frame.height;
    ctx.drawImage(frame, 0, 0);
    const { data } = ctx.getImageData(0, 0, frame.width, frame.height);
    // The matte video is grayscale (R === G === B by construction, see
    // FalVeedProvider/VEED's own h264 matte-stream output) -- the R channel
    // IS the luma value, read directly as a 0..255 Uint8 alpha scale
    // (alphaMaskFromValues' `scale` param normalizes it to 0..1).
    const luma = new Uint8Array(frame.width * frame.height);
    for (let i = 0; i < luma.length; i++) luma[i] = data[i * 4];
    masks.push(await alphaMaskFromValues(luma, frame.width, frame.height, 1 / 255));
  }
  return masks;
}
