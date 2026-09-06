/**
 * Client-side face detection for the "Torus above head" / "Halo behind
 * head" cutaway effects (camera3D.ts's `faceEffect` param) -- runs Google
 * MediaPipe's Face Landmarker directly in the browser against a Ken Burns
 * photo, once per unique image asset (same one-shot-per-asset shape as
 * backgroundSegmentation.ts's segmentImageApproximate, not a per-frame
 * cost), and reduces its 478-point face mesh down to the few measurements
 * camera3D.ts actually needs to place a glowing 3D object relative to the
 * head: where the top of the head is, where the head's center is, how wide
 * the face is (to scale the object proportionally instead of a fixed pixel
 * size), and how much the head is tilted (so the object tilts with it).
 *
 * `@mediapipe/tasks-vision` already ships FaceLandmarker alongside the
 * ImageSegmenter backgroundSegmentation.ts uses -- no new dependency.
 *
 * All positions/measurements below are normalized to the FULL original
 * photo, not whatever sub-rect of it the current Ken Burns crop happens to
 * be showing (that changes every frame as the pan/zoom animates) --
 * projecting a fixed point through the CURRENT crop rect into scene
 * coordinates is camera3D.ts's own job at draw time, not this module's.
 *
 * NOT verified against a live browser run (no environment available while
 * writing this to actually load a real photo through FaceLandmarker) --
 * confirm before relying on it in production:
 *  1. That landmark indices 10/152/234/454/33/263 really are
 *     hairline-center/chin/left-cheek/right-cheek/left-eye-outer/
 *     right-eye-outer on this model's actual 478-point topology (these are
 *     the commonly documented indices for MediaPipe's canonical face mesh,
 *     but double-check visually -- see this feature's own plan doc's
 *     Verification section for a debug-dot technique).
 *  2. That the TOP_OF_HEAD_EXTRAPOLATION_FACTOR below (0.55) reads as a
 *     natural "top of skull" placement rather than too high/low -- it's an
 *     approximation (a face mesh's topology stops at the hairline, so there
 *     is no literal skull-top landmark to read), not a measured constant.
 *  3. That this model URL is still live and CORS-accessible from a browser
 *     (Google's own hosted MediaPipe model bucket, not this app's own
 *     infra) -- if it 404s/CORS-fails, getFaceLandmarker's promise rejects
 *     and detectFaceGeometry falls back to `null` (see its own try/catch),
 *     same "fails toward looks normal" fallback backgroundSegmentation.ts
 *     already uses.
 */
import { FaceLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// Pinned to the exact installed @mediapipe/tasks-vision version (see
// package.json) -- the WASM binaries must match the JS bindings' own
// expected ABI. Note backgroundSegmentation.ts's own WASM_BASE_PATH is
// stale at @0.10.14 (predates the current 1.0.1 install); not touched here
// since fixing that is outside this feature's scope, but this module pins
// correctly rather than copying that drift forward.
const WASM_BASE_PATH = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_ASSET_PATH =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";

export type FaceEffectId = "torus" | "halo";

export interface FaceEffectOption {
  id: FaceEffectId;
  label: string;
  description: string;
}

export const FACE_EFFECT_OPTIONS: FaceEffectOption[] = [
  { id: "torus", label: "Torus Above Head", description: "A glowing ring floats and slowly spins just above the head." },
  { id: "halo", label: "Halo Behind Head", description: "A soft glowing ring sits behind the head, like a halo." },
];

export interface FaceGeometry {
  imageWidth: number;
  imageHeight: number;
  // 0..1 fractions of the FULL original photo -- NOT the current Ken Burns
  // crop rect (see this module's own doc comment).
  headCenterXFraction: number;
  headCenterYFraction: number;
  topOfHeadXFraction: number;
  topOfHeadYFraction: number;
  // (left-cheek-to-right-cheek distance) / imageWidth -- a scale reference
  // so the glow object's size follows the face's actual size in the photo
  // rather than a fixed pixel size that would look wrong on a close-up vs.
  // a far-away photo.
  faceWidthFraction: number;
  // In-plane head tilt (radians), from the eye-corner line -- so the glow
  // object tilts along with a tilted head instead of always sitting
  // perfectly level.
  rollRadians: number;
}

let landmarkerPromise: Promise<FaceLandmarker> | null = null;

function getFaceLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = FilesetResolver.forVisionTasks(WASM_BASE_PATH).then((fileset) =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_ASSET_PATH, delegate: "CPU" },
        // A single still photo, analyzed once -- same "IMAGE, not VIDEO"
        // reasoning as this being a one-shot-per-asset call, not a
        // per-frame one.
        runningMode: "IMAGE",
        numFaces: 1,
      })
    );
  }
  return landmarkerPromise;
}

// A second, independent FaceLandmarker instance in MediaPipe's "VIDEO"
// running mode -- used by detectFaceGeometryForVideoFrame (the camera
// Record page's live per-frame detection), kept entirely separate from
// getFaceLandmarker's IMAGE-mode instance above rather than reconfiguring
// one shared instance, since MediaPipe ties running mode to the instance
// and the two call sites (one-shot photo vs. repeated live-video frames)
// are never used from the same page at once anyway.
let videoLandmarkerPromise: Promise<FaceLandmarker> | null = null;

function getVideoFaceLandmarker(): Promise<FaceLandmarker> {
  if (!videoLandmarkerPromise) {
    videoLandmarkerPromise = FilesetResolver.forVisionTasks(WASM_BASE_PATH).then((fileset) =>
      FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_ASSET_PATH, delegate: "CPU" },
        runningMode: "VIDEO",
        numFaces: 1,
      })
    );
  }
  return videoLandmarkerPromise;
}

// Canonical MediaPipe face-mesh landmark indices (fixed for every
// detection -- not tuned/arbitrary). See this module's own doc comment,
// caveat #1, for the "not verified against a live run" flag.
const LM_HAIRLINE_CENTER = 10;
const LM_CHIN = 152;
const LM_LEFT_CHEEK = 234;
const LM_RIGHT_CHEEK = 454;
const LM_LEFT_EYE_OUTER = 33;
const LM_RIGHT_EYE_OUTER = 263;

// See this module's own doc comment, caveat #2 -- an approximation, not a
// measured quantity.
const TOP_OF_HEAD_EXTRAPOLATION_FACTOR = 0.55;

interface Point {
  x: number;
  y: number;
}

/** Distance between two normalized (0..1) landmarks, in PIXEL space -- a
 * non-square photo skews plain fraction-space distances/angles, so every
 * measurement below goes through pixel space first. */
function distPx(a: Point, b: Point, imageWidth: number, imageHeight: number): number {
  const dx = (a.x - b.x) * imageWidth;
  const dy = (a.y - b.y) * imageHeight;
  return Math.hypot(dx, dy);
}

/** Shared reduction from a raw 478-point face mesh down to FaceGeometry --
 * used by both detectFaceGeometry (IMAGE mode, a still photo) and
 * detectFaceGeometryForVideoFrame (VIDEO mode, a live camera frame) so the
 * landmark-index/extrapolation math below lives in exactly one place. */
function landmarksToFaceGeometry(landmarks: Point[], imageWidth: number, imageHeight: number): FaceGeometry | null {
  const hairlineCenter = landmarks[LM_HAIRLINE_CENTER];
  const chin = landmarks[LM_CHIN];
  const leftCheek = landmarks[LM_LEFT_CHEEK];
  const rightCheek = landmarks[LM_RIGHT_CHEEK];
  const leftEyeOuter = landmarks[LM_LEFT_EYE_OUTER];
  const rightEyeOuter = landmarks[LM_RIGHT_EYE_OUTER];
  if (!hairlineCenter || !chin || !leftCheek || !rightCheek || !leftEyeOuter || !rightEyeOuter) return null;

  // Extrapolate past the hairline along the hairline->chin vector -- a
  // face mesh's own topology stops at the hairline, so "top of head" (the
  // actual skull top, above the hair) has no literal landmark to read.
  const topOfHeadX = hairlineCenter.x + (hairlineCenter.x - chin.x) * TOP_OF_HEAD_EXTRAPOLATION_FACTOR;
  const topOfHeadY = hairlineCenter.y + (hairlineCenter.y - chin.y) * TOP_OF_HEAD_EXTRAPOLATION_FACTOR;

  const faceWidthPx = distPx(leftCheek, rightCheek, imageWidth, imageHeight);
  const eyeDx = (rightEyeOuter.x - leftEyeOuter.x) * imageWidth;
  const eyeDy = (rightEyeOuter.y - leftEyeOuter.y) * imageHeight;

  return {
    imageWidth,
    imageHeight,
    headCenterXFraction: (topOfHeadX + chin.x) / 2,
    headCenterYFraction: (topOfHeadY + chin.y) / 2,
    topOfHeadXFraction: topOfHeadX,
    topOfHeadYFraction: topOfHeadY,
    faceWidthFraction: faceWidthPx / imageWidth,
    rollRadians: Math.atan2(eyeDy, eyeDx),
  };
}

/** Detects the (first/largest) face in a still photo and reduces it to the
 * handful of measurements camera3D.ts needs to place a glow object relative
 * to the head. Returns `null` on load failure, detection failure, or no
 * face found -- callers should render the clip exactly as if no faceEffect
 * were set in that case ("fails toward looks normal", same fallback
 * philosophy as backgroundSegmentation.ts). */
export async function detectFaceGeometry(image: HTMLImageElement | ImageBitmap): Promise<FaceGeometry | null> {
  const imageWidth = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
  const imageHeight = image instanceof HTMLImageElement ? image.naturalHeight : image.height;

  let landmarker: FaceLandmarker;
  try {
    landmarker = await getFaceLandmarker();
  } catch (err) {
    console.error("[faceLandmarks] failed to load MediaPipe FaceLandmarker", err);
    return null;
  }

  try {
    const bitmap = image instanceof ImageBitmap ? image : await createImageBitmap(image);
    const result = landmarker.detect(bitmap);
    const landmarks = result.faceLandmarks?.[0];
    if (!landmarks || landmarks.length === 0) return null;
    return landmarksToFaceGeometry(landmarks, imageWidth, imageHeight);
  } catch (err) {
    console.error("[faceLandmarks] detect failed for image", err);
    return null;
  }
}

/** Live per-frame counterpart to detectFaceGeometry, for the camera Record
 * page's "Torus"/"Halo" face effect over a real-time video stream rather
 * than a still photo -- same reduction, same "fails toward looks normal"
 * null fallback, but reads directly off an HTMLVideoElement via MediaPipe's
 * VIDEO running mode instead of decoding one still image.
 *
 * `timestampMs` must strictly increase across calls for the same video
 * element (MediaPipe's own VIDEO-mode requirement) -- pass a monotonic
 * clock like `performance.now()`, not a timestamp derived from the video's
 * own currentTime (which can repeat/rewind on some browsers' rAF timing).
 * Callers should throttle how often this runs (e.g. every ~150ms) rather
 * than every rAF tick -- detection quality doesn't need per-frame
 * granularity for a slowly-drifting head-locked glow, and MediaPipe's own
 * per-call cost isn't free. */
export async function detectFaceGeometryForVideoFrame(video: HTMLVideoElement, timestampMs: number): Promise<FaceGeometry | null> {
  if (video.videoWidth === 0 || video.videoHeight === 0) return null;

  let landmarker: FaceLandmarker;
  try {
    landmarker = await getVideoFaceLandmarker();
  } catch (err) {
    console.error("[faceLandmarks] failed to load MediaPipe FaceLandmarker (video)", err);
    return null;
  }

  try {
    const result = landmarker.detectForVideo(video, timestampMs);
    const landmarks = result.faceLandmarks?.[0];
    if (!landmarks || landmarks.length === 0) return null;
    return landmarksToFaceGeometry(landmarks, video.videoWidth, video.videoHeight);
  } catch (err) {
    console.error("[faceLandmarks] detectForVideo failed", err);
    return null;
  }
}
