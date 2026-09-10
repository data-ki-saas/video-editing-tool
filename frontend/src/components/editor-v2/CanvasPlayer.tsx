"use client";

/**
 * Preview player for the video sequence -- playback only, no crop editing
 * here (that lives entirely on FrameStrip's timeline now; see its module
 * comment). This player renders the actual CROPPED result: each frame is
 * drawn by sampling only the region CropRect/ZoomEffect say should be kept
 * at that instant and scaling it to fill the canvas, so what's shown is
 * "the final outcome of the work done in the timeline," not the full
 * uncropped frame with a guide drawn over it.
 *
 * Does NOT rely on the browser's native <video> element during playback --
 * a rough approximation of the final render while the user is editing, not
 * a frame-perfect one. Takes an ORDERED list of clips (`clips` prop, one
 * per video asset in the sequence -- see video_math.ts's SequenceClipInfo/
 * resolveSequencePosition) rather than one asset: on mount/sequence-change
 * it extracts each clip's own capped, device/duration-adapted frame set
 * (lib/video/video_math.ts's pickPreviewFrameRate, lib/video/video.ts's
 * extractPreviewFrames) and decodes each clip's audio track
 * (lib/video/audio.ts's decodeAudioBuffer) PIPELINED up to
 * CLIP_LOAD_CONCURRENCY clips at once (2, not the whole sequence at once --
 * full parallelism would multiply peak memory by clip count, since decoding
 * fully loads a whole file into memory with no streaming; 2 overlaps one
 * clip's network/decode latency with the next while still bounding memory to
 * roughly "2 clips' worth"), then concatenates the decoded buffers into ONE continuous
 * AudioBuffer (audio.ts's concatenateAudioBuffers) so playback is still
 * driven by a single AudioContext clock + one AudioBufferSourceNode, never
 * touching any original video file again once loaded. A clip that fails to
 * load is skipped (this player still plays the rest of the sequence); if
 * every clip fails, the player shows the same full error state as before.
 *
 * Frame selection during playback is pure math: `elapsedSeconds` resolves
 * to {clipIndex, localSeconds} via resolveSequencePosition, then
 * frameIndexAtTime picks that clip's own frame -- driven by
 * AudioContext.currentTime, no listening to a hidden <video>'s
 * timeupdate/seeked events, and no per-frame syncing logic at all.
 *
 * Canvas pixel size is fixed to the PROJECT'S REAL OUTPUT resolution --
 * computeOutputDimensions(outputAspectRatio) (video_math.ts), the exact same
 * helper both the local and cloud render paths use to size their own output
 * -- not recomputed from whichever frame or crop rect is currently drawn.
 * Ken Burns zoom and clip-rectangle cropping only ever change which SOURCE
 * rectangle drawFrameAt samples (sx/sy/sWidth/sHeight below); the
 * destination canvas stays pinned at that one fixed resolution throughout.
 * Get this backwards -- e.g. sizing the canvas itself down to the crop
 * rect's own (shrinking, while zoomed in) pixel extent -- and the preview
 * silently renders at a lower resolution than the real render, then the
 * browser stretches that softer bitmap back up via the canvas element's CSS
 * size, visibly softening every zoom-in; worse, since an image clip's crop
 * can carry a different aspect ratio than the sequence's other clips, that
 * bug would also briefly change the canvas's OWN shape during a photo
 * cutaway, not just its sharpness.
 *
 * Exposes an imperative `seekTo` (via ref) so the Playground's frame-strip
 * timeline can scrub this player, and reports playback position upward via
 * `onTimeUpdate` every tick so that timeline can draw a moving playhead --
 * see ThreePaneEditor for how the two are wired together.
 *
 * `musicClips` (see video_math.ts's MusicClip, same array BackgroundTrackStrip
 * visualizes) play here too, mixed under the main clip audio at a fixed,
 * lower gain -- one AudioBufferSourceNode scheduled per clip at its own
 * startTimeSeconds, same "schedule everything ahead of time" idiom the
 * video-overlay-audio block above it already uses, with `loop`/`loopStart`/
 * `loopEnd` set so a clip stretched past one play-through of its own source
 * wraps back to its own trim-in point (sourceStartSeconds) rather than 0.
 * Each distinct asset is decoded once (by assetId, not per clip) in its own
 * effect, independent of the main clips-loading effect, so adding/moving a
 * music clip doesn't re-extract every video frame from scratch; if a clip's
 * audio is still decoding (or absent) when Play is pressed, that one clip
 * simply plays without sound that time around rather than blocking playback.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { extractPreviewFrames, getVideoDuration, drawImageFlipped, drawImageFlippedMasked } from "@/lib/video/video";
import { Camera3DRenderer, computeCamera3DPoseForZoomEffect, computeCamera3DPoseForOverlay, NEUTRAL_POSE } from "@/lib/video/camera3D";
import { drawAmbientEffect, ambientEffectSeed } from "@/lib/video/ambientEffects";
import { detectFaceGeometry, type FaceGeometry } from "@/lib/video/faceLandmarks";
import { computeAudioEnvelope, sampleMusicClipsEnvelopeAt, audioReactiveScale, type AudioEnvelope } from "@/lib/video/audioReactive";
import { normalizeImageTemplateIds } from "@/lib/video/imageTemplates";
import { segmentClipFramesApproximate, lumaFramesToAlphaMasks, segmentImageApproximate } from "@/lib/video/backgroundSegmentation";
import { chromaKeyFramesToAlphaMasks, chromaKeyImageToBitmap, DEFAULT_CHROMA_KEY_COLOR } from "@/lib/video/chromaKey";
import { drawBrandWatermark } from "@/lib/video/brandWatermark";
import { decodeAudioBuffer, concatenateAudioBuffers } from "@/lib/video/audio";
import {
  frameIndexAtTime,
  pickPreviewFrameRate,
  computeEffectiveCropRect,
  findActiveZoomEffectIndex,
  reprojectCropRect,
  computeEffectiveFlip,
  skipTrimmedRanges,
  findActiveTextOverlays,
  findActiveExclusiveOverlay,
  findActivePictureInPictureOverlays,
  computeOverlayRects,
  computeCoverFitSourceRect,
  MIN_PICTURE_IN_PICTURE_ZOOM,
  computeProgress,
  computeAudioMixBreakpoints,
  sampleAudioMixAt,
  AUDIO_TRANSITION_RAMP_SECONDS,
  DEFAULT_OVERLAY_FRAMING,
  buildSequenceClipInfos,
  totalSequenceDuration,
  resolveSequencePosition,
  resolveCutTransitionBlend,
  resolveCutTransitionOverlapSeconds,
  buildVirtualCutTransitionSkipRanges,
  findActiveTtsOverlays,
  ttsOverlayEndTimeSeconds,
  findActiveWordIndex,
  computeOutputDimensions,
  computeMaxCoverageCropRect,
  computeContainFitRect,
  FULL_FRAME_CROP_RECT,
  scaleCropRectCentered,
  type CropRect,
  type ImageOverlayClip,
  type MusicClip,
  type SequenceClipInfo,
  type SequenceEntry,
  type TextOverlay,
  type TtsOverlay,
  type VideoOverlayClip,
  type BackgroundRemovalState,
  type TrimRange,
  type ZoomEffect,
  type TranscriptCaption,
} from "@/lib/video/video_math";
import { getTextTemplateRenderer, drawKaraokeCaption } from "@/lib/video/textTemplates";
import { drawTextSlide, type TextSlideEntry } from "@/lib/video/textSlideRenderer";
import { getFilterPresetOption } from "@/lib/video/filterPresets";
import {
  getCanvasFillMode,
  CANVAS_FILL_BLUR_RADIUS_FRACTION,
  DEFAULT_CANVAS_FILL_COLOR,
  DEFAULT_CANVAS_FILL_GRADIENT_COLOR,
} from "@/lib/video/canvasFillPresets";
import type { CutTransitionId } from "@/lib/video/cutTransitionPresets";
import { loadCrossOriginImage } from "@/lib/crossOriginImage";
import { ReelLoader } from "@/components/ReelLoader";
import { PlayIcon, PauseIcon, LoopIcon, ExpandIcon, CollapseIcon, RenderIcon, LocalRenderIcon } from "./icons/PlayerIcons";
import { SpeakerFullIcon, SpeakerMutedIcon } from "@/components/icons/UIIcons";

const TERMINAL_RENDER_STATUSES = new Set(["completed", "failed"]);

export interface CanvasPlayerHandle {
  seekTo(seconds: number): void;
  // Grabs the exact pixels currently drawn to the preview canvas as a JPEG
  // Blob -- backs CoverPicker's "use current frame" action. Deliberately
  // NOT a re-render: this file's own module comment already notes the live
  // preview is an approximation of the real render (CSS-filter/transition
  // shortcuts), but a cover image only needs to match what the user is
  // looking at when they click, so that's authoritative by construction
  // here. Resolves null if nothing has been drawn yet (isReady false) or
  // the browser's toBlob fails.
  captureFrame(): Promise<Blob | null>;
  // Stops live playback if it's currently running (no-op otherwise) --
  // ThreePaneEditor.tsx's handleLocalRenderClick calls this right before
  // Edge Render starts, since a still-running preview competes with the
  // export for the same decode/audio resources and would otherwise keep
  // playing behind the render popup.
  pause(): void;
}

/** Loads `src` via fetch()+blob URL rather than a plain `<img>` (or one with
 * `crossOrigin="anonymous"`) -- CoverPicker's "use current frame" reads
 * pixels back off this canvas via captureFrame()/toBlob, and a cross-origin
 * image drawn onto it without a real CORS response taints the whole canvas.
 * This is the ORIGINAL discovery site of a real production incident: this
 * exact URL is also loaded elsewhere (AssetGallery's thumbnail, Cutaway's
 * preview, etc.) via a plain `<img>` -- doing so requests it in "no-cors"
 * mode, which the browser can cache as an opaque, header-less response; a
 * LATER "cors"-mode fetch for the identical URL (this function) can then be
 * served that cached opaque response instead of a fresh CORS-checked one,
 * failing with "No 'Access-Control-Allow-Origin' header is present" even
 * though the bucket's real CORS policy is completely correct --
 * `crossOrigin="anonymous"` on a plain `<img>` does NOT protect against
 * this, since the poisoning happens at whichever OTHER call site loads the
 * URL first without it. The real fix (see crossOriginImage.ts's fuller
 * writeup) is for EVERY caller across the app to load a project asset's URL
 * through loadCrossOriginImage instead of a plain `<img>`/`new Image()` --
 * this function is now a thin wrapper over that shared implementation,
 * revoking the blob URL immediately once decoded (safe here: the pixel
 * data is already captured into the image element by then, and this
 * function's callers only ever need pixels, never a long-lived <img src>). */
function loadImage(src: string): Promise<HTMLImageElement> {
  return loadCrossOriginImage(src).then(({ image, blobUrl }) => {
    URL.revokeObjectURL(blobUrl);
    return image;
  });
}

// Radians/second the badge below spins at -- fast enough to visibly read as
// "still working" at a glance, not so fast it looks like a glitch.
const BACKGROUND_REMOVAL_SPINNER_RADIANS_PER_SECOND = 6;

/** A small spinning-arc badge in an overlay's top-right corner, drawn OVER
 * whatever's already been composited there -- the live-preview cue that a
 * video overlay's cutout isn't ready yet. See isVideoOverlayMattePending
 * below for the two things this covers ("ai" mode's backend job, chroma
 * key's local computation). Drawn regardless of whether an approximate
 * MediaPipe fallback mask is already showing underneath in "ai" mode (see
 * CanvasPlayer's own videoOverlayMattesByAssetIdRef loading effect) -- that
 * fallback is a reasonable preview, but this badge is the definitive "the
 * real cutout isn't final yet" signal. `elapsedSeconds` drives the spin so
 * it animates during playback; a paused frame just redraws at whatever angle
 * that instant implies, same as every other elapsedSeconds-driven visual in
 * this file. Never called from exportTimeline.ts/compileCreatomateTimeline.ts
 * -- this is a GUI-only loading cue, not something that should ever bake
 * into rendered output. */
function drawBackgroundRemovalSpinnerBadge(
  ctx: CanvasRenderingContext2D,
  destX: number,
  destY: number,
  destWidth: number,
  destHeight: number,
  elapsedSeconds: number
) {
  const radius = Math.min(16, Math.min(destWidth, destHeight) * 0.18);
  if (radius < 3) return; // box too small for the badge to read as anything but a smudge
  const centerX = destX + destWidth - radius - 4;
  const centerY = destY + radius + 4;

  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  ctx.fill();

  const angle = (elapsedSeconds * BACKGROUND_REMOVAL_SPINNER_RADIANS_PER_SECOND) % (Math.PI * 2);
  ctx.beginPath();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = Math.max(1.5, radius * 0.22);
  ctx.lineCap = "round";
  ctx.arc(centerX, centerY, radius * 0.55, angle, angle + Math.PI * 1.2);
  ctx.stroke();
  ctx.restore();
}

/** Whether a video overlay's cutout is still pending -- the two modes signal
 * "not ready" completely differently, so this is the one place that knows
 * how to ask either one. "ai" mode is pending until the backend's real
 * `matteAssetId` arrives (see video_math.ts's BackgroundRemovalState doc
 * comment) -- an approximate MediaPipe mask may already be drawn underneath,
 * but that's a preview, not the signal this tracks. Chroma key never has a
 * `matteAssetId` at all (it's computed locally, see chromaKey.ts's own
 * module comment) -- pending there means its own `mattes` array (passed in
 * by the caller, from videoOverlayMattesByAssetIdRef) hasn't landed yet. */
function isVideoOverlayMattePending(backgroundRemoval: BackgroundRemovalState | null | undefined, mattes: ImageBitmap[] | undefined): boolean {
  if (!backgroundRemoval?.enabled) return false;
  if (backgroundRemoval.mode === "chromaKey") return !mattes || mattes.length === 0;
  return !backgroundRemoval.matteAssetId;
}

/** The pip-loading placeholder for a resource that hasn't produced its first
 * frame at all yet (source frames not extracted) -- distinct from the
 * spinner badge above, which overlays already-visible (if not yet keyed)
 * footage. Without this, a pip whose source is still being fetched/decoded
 * is simply invisible (see the `!frames` branch in the pip draw loop below),
 * which reads as broken rather than loading -- this fills the pip's own
 * rect with a dark scrim so the spinner badge drawn on top of it has
 * something to visually anchor to. */
function drawPipLoadingPlaceholder(ctx: CanvasRenderingContext2D, destX: number, destY: number, destWidth: number, destHeight: number, elapsedSeconds: number) {
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(destX, destY, destWidth, destHeight);
  ctx.restore();
  drawBackgroundRemovalSpinnerBadge(ctx, destX, destY, destWidth, destHeight, elapsedSeconds);
}

export const CanvasPlayer = forwardRef<
  CanvasPlayerHandle,
  {
    // Every clip in the sequence, in order -- see this file's module
    // comment and video_math.ts's SequenceClipInfo/resolveSequencePosition.
    // An "image" entry is treated as a video with exactly one frame, held
    // for its own authored durationSeconds, with silent audio.
    clips: (SequenceEntry & { url: string })[];
    baseCropRect: CropRect | null;
    zoomEffects: ZoomEffect[];
    // Overrides the computed crop for the CURRENT static frame while
    // paused -- lets the player preview a drag happening on FrameStrip's
    // active tile live, before it's committed. Never applied during
    // playback (dragging and playing at once isn't a real scenario).
    liveCropRectOverride?: CropRect | null;
    // The project's real output ratio (width/height) -- same value the
    // local/cloud render paths derive from the selected clip rectangle (see
    // ThreePaneEditor's handleLocalRenderClick) -- fed into
    // computeOutputDimensions to pin this player's canvas to the actual
    // render resolution. See this file's own module comment.
    outputAspectRatio: number;
    // "Flip" (horizontal) / "Mirror" (vertical) -- sorted toggle
    // timestamps, not a uniform whole-clip boolean, toggled from
    // CropRectOverlay's edge handles on FrameStrip's active tile (the
    // player itself is playback-only). Evaluated per-frame inside
    // drawFrameAt (see computeEffectiveFlip) since which way is "on" can
    // change mid-playback.
    flipHorizontalToggles: number[];
    flipVerticalToggles: number[];
    // Cut-out stretches of the clip (see video_math.ts's TrimRange) --
    // genuinely skipped during playback and on every seek (skipTrimmedRanges
    // below), not merely marked, so what plays here matches what FrameStrip's
    // dimmed tiles promise is gone.
    trimRanges: TrimRange[];
    // Image assets composited on top of the base frame for their own time
    // range, with the SAME switchable Full-Screen/Picture-in-Picture/Split
    // Screen layout as videoOverlays below (see video_math.ts's
    // ImageOverlayClip) -- `assetUrlById` resolves each overlay's assetId to
    // the actual R2 URL to load and draw, kept separate from ImageOverlayClip
    // itself since that's persisted state and has no business holding a URL
    // that expires.
    overlayImages: ImageOverlayClip[];
    // Text captions composited on top of the base frame, rendered via a
    // named template (see lib/video/textTemplates.ts) -- drawn after image
    // overlays, so text always sits above them.
    textOverlays: TextOverlay[];
    // TTS-generated narration -- its own audio (decoded/scheduled here, see
    // this file's module comment) plus its own on-screen caption, drawn
    // after textOverlays (narration reads as the most prominent caption
    // layer). `displayMode: "background"` reuses the exact same
    // TEXT_TEMPLATE_RENDERERS machinery textOverlays already uses (it's
    // just text-with-a-template); `displayMode: "karaoke"` uses a dedicated
    // word-highlight renderer (see this file's own drawKaraokeCaption) since
    // exact per-word timings from the synthesis itself (not ASR) make a
    // live-accurate highlight actually achievable, unlike TranscriptCaption.
    ttsOverlays: TtsOverlay[];
    // A second video asset on its own rail, with a switchable layout (see
    // video_math.ts's VideoOverlayClip) -- drawn right after the base
    // frame (before image/text overlays), same tier as those. `assetUrlById`
    // (below) resolves each overlay's assetId the same way it already does
    // for image overlays.
    videoOverlays: VideoOverlayClip[];
    assetUrlById: Record<string, string>;
    // Freely positioned/resizable background-music clips (see
    // video_math.ts's MusicClip and BackgroundTrackStrip.tsx) -- each
    // scheduled at its own startTimeSeconds, mixed into playback here (see
    // this file's module comment). Resolved against `assetUrlById` above,
    // same convention as videoOverlays/ttsOverlays.
    musicClips: MusicClip[];
    // Flat 0..1 multipliers set from each audio rail's own VolumeFader (see
    // Playground.tsx) -- mainAudioVolume scales the main sequence's own
    // audio (still ducked underneath it during an overlay window that wants
    // its own audio mixed in, same as before this existed -- see
    // computeAudioMixBreakpoints); backgroundVolume scales the
    // background-music gain directly, replacing what was a hardcoded
    // constant.
    mainAudioVolume: number;
    backgroundVolume: number;
    onFrameDimensions?: (dimensions: { width: number; height: number }) => void;
    onTimeUpdate?: (seconds: number) => void;
    // Cloud Render + local/free Edge Render, shown alongside Play/Loop/
    // Fullscreen below since both act on the reel currently in this
    // preview. Omitted entirely by MobileEditor.tsx (the other caller),
    // which has no render UI -- the buttons only render when this is set.
    renderControls?: {
      canRender: boolean;
      isRendering: boolean;
      renderStatus: string | null;
      onRenderClick: () => void;
      canLocalRender: boolean;
      isLocalRendering: boolean;
      isLocalRenderSupported: boolean;
      localRenderUnsupportedReason: string | null;
      onLocalRenderClick: () => void;
      transcriptCaption: TranscriptCaption | null;
    };
  }
>(function CanvasPlayer(
  {
    clips,
    baseCropRect,
    zoomEffects,
    liveCropRectOverride = null,
    outputAspectRatio,
    flipHorizontalToggles,
    flipVerticalToggles,
    trimRanges,
    overlayImages,
    textOverlays,
    ttsOverlays,
    videoOverlays,
    assetUrlById,
    musicClips,
    mainAudioVolume,
    backgroundVolume,
    onFrameDimensions,
    onTimeUpdate,
    renderControls,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Each clip's own filter, keyed by SequenceEntry.id -- looked up by id
  // (via loadedClipsRef's own `.id`, see its comment below) rather than by
  // position, since a clip that failed to load shifts every later index out
  // of alignment with the `clips` prop.
  const clipFilterById = new Map(clips.map((clip) => [clip.id, clip.kind === "text" ? null : (clip.colorFilterId ?? null)]));
  // Each clip's own canvas fill (see canvasFillPresets.ts) -- same id-keyed
  // lookup shape as clipFilterById above.
  const clipCanvasFillById = new Map(
    clips.map((clip) => [
      clip.id,
      { mode: getCanvasFillMode(clip.canvasFillMode), color: clip.canvasFillColor, gradientColor: clip.canvasFillGradientColor },
    ])
  );
  // Which cut-transition (see cutTransitionPresets.ts) plays INTO each clip
  // from whichever clip precedes it -- same id-keyed lookup shape as
  // clipFilterById above. Distinct from this codebase's OTHER "transition"
  // (the pan/zoom Ken Burns effect) -- see video_math.ts's
  // SequenceEntry.cutTransitionInId doc comment.
  const cutTransitionById: Map<string, CutTransitionId | null | undefined> = new Map(
    clips.map((clip) => [clip.id, clip.kind === "text" ? null : (clip.cutTransitionInId ?? null)])
  );
  // Every Text Slide entry, keyed by id -- looked up in drawFrameAt's own
  // early-return branch below via loadedClipsRef's reduced per-clip meta
  // (which only carries id/assetId/url/durationSeconds/kind, not this
  // entry's own text/style/layout/transitions), same "look it up by id from
  // the ORIGINAL clips prop" reasoning as clipFilterById above.
  const textSlideEntryById = new Map(
    clips.filter((clip): clip is TextSlideEntry & { url: string } => clip.kind === "text").map((clip) => [clip.id, clip])
  );
  // AI background removal for a Ken Burns (image) cutaway -- true means
  // "draw a backdrop first, then this clip's own (already-transparent)
  // frame on top, no separate matte compositing needed" (see drawFrameAt's
  // own masked-composite branch, which this shares with the video path's
  // `matte` signal). A VIDEO clip's equivalent signal is `matte` itself
  // (an actual per-frame alpha carrier, see clipMattesRef) -- images don't
  // populate that ref at all, since the cutout is baked directly into the
  // single loaded frame (see the loading effect's own image branch).
  const clipBackgroundRemovalById = new Map(clips.map((clip) => [clip.id, clip.kind === "image" && Boolean(clip.backgroundRemoval?.enabled)]));
  // "Make it 3D" (lib/video/camera3D.ts) -- true only for an image clip
  // (a Ken Burns cutaway) with the toggle on; a plain video clip has no
  // pan/zoom motion to attach a dolly to, same scope as this feature's own
  // plan doc. templateIds is looked up alongside it (not derived at draw
  // time) since computeCamera3DPoseForZoomEffect needs it to pick a tilt/
  // roll direction -- same id-keyed lookup shape as clipFilterById above.
  const clipCamera3DById = new Map(clips.map((clip) => [clip.id, clip.kind === "image" && Boolean(clip.camera3D)]));
  const clipTemplateIdsById = new Map(clips.map((clip) => [clip.id, clip.kind === "image" ? normalizeImageTemplateIds(clip) : []]));
  // Ambient overlay effect (lib/video/ambientEffects.ts) -- same image-only
  // scope as clipCamera3DById above, independent of it (works with or
  // without "Make it 3D" active).
  const clipAmbientEffectById = new Map(clips.map((clip) => [clip.id, clip.kind === "image" ? (clip.ambientEffect ?? null) : null]));
  // Face-locked glow (lib/video/faceLandmarks.ts + camera3D.ts's halo/torus)
  // -- same image-only scope as clipCamera3DById above, mutually exclusive
  // with itself (one FaceEffectId or null) but independent of camera3D/
  // ambientEffect. Also a no-op whenever backgroundRemoval is enabled, same
  // scoping as camera3DSubjectCutout's own comment: that combination keeps
  // the existing flat cutout-over-a-new-backdrop treatment unchanged rather
  // than trying to reconcile it with the halo's own occlusion trick (which
  // assumes a SEPARATE opaque background behind the cutout, not the single
  // already-transparent image backgroundRemoval leaves in its place).
  const clipFaceEffectById = new Map(
    clips.map((clip) => [clip.id, clip.kind === "image" && !clip.backgroundRemoval?.enabled ? (clip.faceEffect ?? null) : null])
  );
  // "Pulse with music" (lib/video/audioReactive.ts) -- same image-only scope
  // as clipCamera3DById above, independent of it and of ambientEffect.
  const clipAudioReactiveById = new Map(clips.map((clip) => [clip.id, clip.kind === "image" && Boolean(clip.audioReactive)]));
  // Per-clip decoded preview frames + frame rate, indexed the same as
  // loadedClipsRef below (NOT necessarily the same as the `clips` prop --
  // a clip that failed to load is excluded from all three in lockstep). A
  // "video" clip's frames are ImageBitmaps straight from extractPreviewFrames
  // (see video.ts); an "image" clip holds a single real HTMLImageElement
  // loaded from its own URL -- both support the .width/.height/drawImage
  // this file needs, so they're used interchangeably below.
  const clipImagesRef = useRef<(HTMLImageElement | ImageBitmap)[][]>([]);
  const frameRatesRef = useRef<number[]>([]);
  // AI background removal (see this feature's own plan doc) -- one alpha
  // mask per frame, same index alignment as clipImagesRef, or null for a
  // clip with no backgroundRemoval active. Populated by the SAME loading
  // effect as clipImagesRef, from whichever source is ready:
  // lumaFramesToAlphaMasks (VEED's real matte, once
  // clip.backgroundRemoval.matteAssetId resolves) or
  // segmentClipFramesApproximate (an instant MediaPipe cutout, while that's
  // still null) -- see backgroundSegmentation.ts's own module comment.
  const clipMattesRef = useRef<(ImageBitmap[] | null)[]>([]);
  // "Make it 3D" foreground/background parallax -- an automatic subject
  // cutout (same segmentImageApproximate MediaPipe model as background
  // removal's own instant fallback, or the clip's real rembg matte if one's
  // already available) for any image clip with camera3D on, computed
  // independently of whether backgroundRemoval itself is enabled (see the
  // loading effect's own comment on why this is skipped when it IS enabled
  // -- that combination keeps today's flat cutout-over-a-new-backdrop
  // treatment unchanged, camera3D stays a no-op there same as before this
  // feature existed). null for any clip this doesn't apply to. Passed to
  // Camera3DRenderer.drawImage3D as its own nearer-camera plane, same
  // depth-plane technique ambientEffects.ts's effect layer already uses --
  // see camera3D.ts's own SUBJECT_DEPTH_FRACTION comment.
  const clipCamera3DSubjectCutoutsRef = useRef<(HTMLImageElement | ImageBitmap | null)[]>([]);
  // Face detection (faceLandmarks.ts) for any image clip with a faceEffect
  // picked -- same one-shot-per-unique-asset shape as
  // clipCamera3DSubjectCutoutsRef above (computed once when the clip loads,
  // not per frame), passed to Camera3DRenderer.drawImage3D to anchor the
  // chosen glow object to the detected head. null for any clip this doesn't
  // apply to, or where no face was found.
  const clipFaceGeometriesRef = useRef<(FaceGeometry | null)[]>([]);
  // Which clips actually loaded, with cumulative start times -- what
  // resolveSequencePosition resolves elapsedSeconds against, and what
  // durationRef.current is derived from (their total).
  const loadedClipsRef = useRef<SequenceClipInfo[]>([]);
  const durationRef = useRef(0);
  // Fixed once per sequence load, from the first loaded clip's first frame.
  // Used only as the aspect-ratio space crop rects are authored/reprojected
  // against (see drawFrameAt's referenceAspectRatio/reprojectCropRect) --
  // NOT to size the canvas itself, which is pinned to the project's real
  // output resolution instead (see this file's own module comment).
  const referenceFrameSizeRef = useRef({ width: 0, height: 0 });
  // Loaded overlay images, keyed by assetId -- populated asynchronously
  // (see the loading effect below), so drawFrameAt just skips an overlay
  // whose image hasn't resolved yet rather than waiting on it.
  const overlayImagesRef = useRef<Record<string, HTMLImageElement>>({});
  // Background-removal cutout for an image overlay's own photo, keyed by
  // assetId (shared across multiple overlay clips reusing the same asset,
  // same convention as overlayImagesRef) -- populated by its own loading
  // effect further below. An image overlay is a single static photo, so
  // (unlike the video-overlay alpha-mask pair above) this follows the base
  // sequence's still-image cutaway path instead: the cutout REPLACES the
  // plain photo outright (a still image's own alpha channel needs no
  // separate mask element), rather than being composited via a mask at
  // draw time.
  const imageOverlayCutoutsByAssetIdRef = useRef<Record<string, HTMLImageElement | ImageBitmap>>({});
  // A Text Slide's own optional background/layout image, keyed by assetId --
  // same "load once, cache by assetId, redraw once ready" shape as
  // overlayImagesRef above, kept as its own ref/effect since text slides
  // come from `clips` (the base sequence) rather than the `overlayImages`
  // prop (see the loading effect further below).
  const textSlideImagesRef = useRef<Record<string, HTMLImageElement>>({});
  // Face detection (faceLandmarks.ts) for an image overlay with a faceEffect
  // picked -- keyed by assetId, same sharing convention as overlayImagesRef
  // above (one-shot per unique asset, populated by the SAME loading effect).
  // Unlike the base sequence's own camera3DSubjectCutout, there is no
  // subject-cutout/occlusion layer for overlays (camera3D's own subject
  // parallax is scoped to sequence clips only -- see SUBJECT_DEPTH_FRACTION's
  // own comment), so an overlay's "halo" pick renders without the
  // peeking-through-the-silhouette occlusion the base sequence gets -- a
  // known, accepted scope limitation, not a bug.
  const overlayFaceGeometriesRef = useRef<Record<string, FaceGeometry | null>>({});
  // Extracted preview frames for every video overlay's own source asset,
  // keyed by assetId (shared across multiple overlay clips reusing the
  // same asset, not per-clip) -- same extractPreviewFrames/frameIndexAtTime
  // pipeline the main sequence's own clips use below, not a live seeked
  // <video> or a single static image, since a video overlay must actually
  // play back over its window.
  const videoOverlayFramesByAssetIdRef = useRef<Record<string, { images: ImageBitmap[]; frameRate: number; durationSeconds: number }>>({});
  // AI background-removal alpha masks for a video overlay's own frames --
  // same sharing convention (keyed by assetId) as videoOverlayFramesByAssetIdRef
  // above, and the same real-matte-or-approximate-fallback staging as the
  // base sequence's own `mattes` (see loadClipAt's video branch below):
  // extracted only for an assetId at least one active overlay clip has
  // backgroundRemoval.enabled on. Index-aligned with that same assetId's
  // entry in videoOverlayFramesByAssetIdRef (same frameRate, same frame
  // count), consumed by drawFrameAt's masked-overlay composite.
  const videoOverlayMattesByAssetIdRef = useRef<Record<string, ImageBitmap[]>>({});
  // Decoded audio for every video overlay source asset that at least one
  // overlay actually wants audio from (audioBalance > 0) -- keyed by
  // assetId, same sharing convention as videoOverlayFramesByAssetIdRef.
  // Overlays with audioBalance === 0 (the default) never decode their
  // asset's audio at all, since nothing would play it.
  const videoOverlayAudioBuffersByAssetIdRef = useRef<Record<string, AudioBuffer>>({});
  // Every overlay-audio source node currently scheduled for this playback
  // pass (one per overlay with audioBalance > 0 and a loaded buffer,
  // scheduled all at once in resumePlaybackFrom -- see its own comment) --
  // stopPlaybackLoop stops and clears all of them together.
  const overlayAudioSourceNodesRef = useRef<AudioBufferSourceNode[]>([]);
  // Decoded audio for every TTS narration overlay's own generated asset,
  // keyed by assetId -- same lazy/cached decode pattern as
  // videoOverlayAudioBuffersByAssetIdRef, just always decoded (unlike video
  // overlays, a TTS overlay's whole point is its audio, there's no
  // audioBalance === 0 opt-out).
  const ttsAudioBuffersByAssetIdRef = useRef<Record<string, AudioBuffer>>({});
  // Every TTS narration source node currently scheduled for this playback
  // pass -- stopPlaybackLoop stops and clears all of them together, same as
  // overlayAudioSourceNodesRef above.
  const ttsAudioSourceNodesRef = useRef<AudioBufferSourceNode[]>([]);
  // One short-lived AudioBufferSourceNode per cut-transition boundary
  // scheduled for this playback pass -- each replays a preview of the
  // incoming clip's own upcoming audio (from the SAME concatenated
  // audioBufferRef.current, since it's sample-aligned to loadedClipsRef's
  // own unshifted absolute-time axis -- see this file's cutTransitionById/
  // getEffectiveSkipRanges) with its own gain ramping in, while
  // mainGainNode dips during the same window -- see resumePlaybackFrom's own
  // scheduleCutTransitionAudioCrossfades. stopPlaybackLoop stops and clears
  // all of them together, same as overlayAudioSourceNodesRef above.
  const cutTransitionAudioSourceNodesRef = useRef<AudioBufferSourceNode[]>([]);

  const audioContextRef = useRef<AudioContext | null>(null);
  // Every gain node below (mainGainNode, overlayGainNode, ttsGainNode,
  // previewGainNode, musicGainNode) connects here instead of straight to
  // audioContext.destination -- one shared node the mute button can toggle
  // without touching any of their own ducking/ramp automation. Created
  // alongside the AudioContext itself (ensureAudioContext), so it's ready
  // before the first resumePlaybackFrom ever schedules a source.
  const masterGainNodeRef = useRef<GainNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  // Decoded audio for every distinct music-clip source asset, keyed by
  // assetId -- same lazy/cached decode pattern as
  // videoOverlayAudioBuffersByAssetIdRef above, decoded independently of the
  // main clips (see this file's module comment) so adding/moving a music
  // clip never re-extracts video frames.
  const musicAudioBuffersByAssetIdRef = useRef<Record<string, AudioBuffer>>({});
  // Every music-clip source node currently scheduled for this playback pass
  // (one per clip whose window overlaps this resume and whose asset has
  // finished decoding) -- stopPlaybackLoop stops and clears all of them
  // together, same as overlayAudioSourceNodesRef above.
  const musicSourceNodesRef = useRef<AudioBufferSourceNode[]>([]);
  // "Pulse with music" (audioReactive.ts) -- one envelope per distinct
  // music-clip asset, distilled once right after that asset's own buffer
  // above finishes decoding, then sampled per frame in drawFrameAt via
  // sampleMusicClipsEnvelopeAt (which picks whichever clip is active).
  const musicEnvelopesByAssetIdRef = useRef<Record<string, AudioEnvelope>>({});
  // Scratch canvas reused across frames for the background-removal masked
  // composite (see drawFrameAt's own "destination-in" branch) -- resized in
  // place rather than reallocated every frame.
  const maskCompositeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  // Resizes/returns the scratch canvas above -- shared by the base clip's
  // own masked composite AND a masked video overlay's (see drawFrameAt's
  // exclusive/PiP overlay branches below), which draw to it at different
  // points in the same frame, so this must re-check the size every call
  // rather than assuming whichever branch ran first already got it right.
  function getMaskCanvas(width: number, height: number): HTMLCanvasElement {
    if (maskCompositeCanvasRef.current === null || maskCompositeCanvasRef.current.width !== width || maskCompositeCanvasRef.current.height !== height) {
      maskCompositeCanvasRef.current = document.createElement("canvas");
      maskCompositeCanvasRef.current.width = width;
      maskCompositeCanvasRef.current.height = height;
    }
    return maskCompositeCanvasRef.current;
  }
  // Camera3DRenderer (camera3D.ts) -- one shared WebGL context, created on
  // first use rather than on mount, since most projects never touch the
  // "Make it 3D" toggle and shouldn't pay for a WebGL context they don't
  // need. Disposed in this component's own unmount effect below.
  const camera3DRendererRef = useRef<Camera3DRenderer | null>(null);
  function getCamera3DRenderer(): Camera3DRenderer {
    if (!camera3DRendererRef.current) camera3DRendererRef.current = new Camera3DRenderer();
    return camera3DRendererRef.current;
  }
  const animationFrameIdRef = useRef<number | null>(null);
  // Wall-clock bookkeeping for the AudioContext-driven playback clock:
  // elapsed = pausedAtSeconds while stopped, or
  // pausedAtSeconds + (ctx.currentTime - playStartedAtCtxTime) while playing.
  const pausedAtSecondsRef = useRef(0);
  const playStartedAtCtxTimeRef = useRef(0);
  // Read by tick() -- which, once scheduled via requestAnimationFrame,
  // keeps calling the SAME closure until the next resumePlaybackFrom, so it
  // never sees a fresh `isLooping` prop/state value on its own. A ref, kept
  // in sync with isLooping alongside every setIsLooping call, makes
  // toggling the loop button WHILE already playing take effect the next
  // time playback reaches the end, not only the next time Play is pressed.
  const isLoopingRef = useRef(false);
  // Same reason as isLoopingRef above: ensureAudioContext (called from the
  // clip-loading effect, not a user gesture) reads this to seed a freshly
  // created masterGainNode's initial gain, so toggling mute BEFORE the audio
  // context exists yet still takes effect once it does. Starts true --
  // preview audio is muted by default (matches every short-form feed's own
  // default: sound is an opt-in the viewer/editor turns on, not something
  // that should play out loud the moment the editor opens).
  const isMutedRef = useRef(true);

  const [isLoading, setIsLoading] = useState(true);
  const [loadingStage, setLoadingStage] = useState("Loading video…");
  const [error, setError] = useState<string | null>(null);
  // A clip that failed to load but wasn't the ONLY one -- shown as a small
  // non-blocking note rather than replacing the whole player (see `error`
  // above for the "every clip failed" case).
  const [partialLoadWarning, setPartialLoadWarning] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  // The whole player row (video panel + controls column, see the root div
  // below) is the fullscreen target -- not just the video panel -- so Play/
  // Loop/full-window stay reachable while it's blown up, instead of vanishing
  // along with the rest of the editor chrome.
  const playerRootRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  /** The real user-authored `trimRanges` PLUS a synthetic "skip" range for
   * every cut-transition boundary (see video_math.ts's own module comment
   * on why CanvasPlayer handles transitions via the trim-skip mechanism
   * rather than shifting clip start times) -- fed into every
   * skipTrimmedRanges call below so playback naturally skips the stretch of
   * an incoming clip already shown early as this file's own transition
   * preview (see drawFrameAt). NEVER passed to TrimTrack's own UI, which
   * must keep showing only genuine user-authored cuts. Recomputed on each
   * call rather than memoized -- loadedClipsRef is a ref, not reactive
   * state, and this list is tiny. */
  function getEffectiveSkipRanges(): TrimRange[] {
    return [...trimRanges, ...buildVirtualCutTransitionSkipRanges(loadedClipsRef.current, cutTransitionById)];
  }

  function ensureAudioContext(): AudioContext {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
      const masterGainNode = audioContextRef.current.createGain();
      masterGainNode.gain.value = isMutedRef.current ? 0 : 1;
      masterGainNode.connect(audioContextRef.current.destination);
      masterGainNodeRef.current = masterGainNode;
    }
    return audioContextRef.current;
  }

  function stopPlaybackLoop() {
    if (animationFrameIdRef.current !== null) {
      cancelAnimationFrame(animationFrameIdRef.current);
      animationFrameIdRef.current = null;
    }
    try {
      sourceNodeRef.current?.stop();
    } catch {
      // Already stopped (e.g. it ran to the end on its own) -- fine to ignore.
    }
    sourceNodeRef.current = null;
    for (const node of musicSourceNodesRef.current) {
      try {
        node.stop();
      } catch {
        // Already stopped -- fine to ignore.
      }
    }
    musicSourceNodesRef.current = [];
    for (const node of overlayAudioSourceNodesRef.current) {
      try {
        node.stop();
      } catch {
        // Already stopped -- fine to ignore.
      }
    }
    overlayAudioSourceNodesRef.current = [];
    for (const node of ttsAudioSourceNodesRef.current) {
      try {
        node.stop();
      } catch {
        // Already stopped -- fine to ignore.
      }
    }
    ttsAudioSourceNodesRef.current = [];
    for (const node of cutTransitionAudioSourceNodesRef.current) {
      try {
        node.stop();
      } catch {
        // Already stopped -- fine to ignore.
      }
    }
    cutTransitionAudioSourceNodesRef.current = [];
  }

  /** The one canonical "how long is this overlay's source, for looping
   * purposes" duration -- prefers the DECODED audio buffer's exact duration
   * (sample-count-derived, no estimation) over the video's own probed
   * duration (container metadata, can differ by a few ms) whenever both
   * exist for the same asset, so video-frame looping and audio looping
   * never drift apart from using two different numbers for what's supposed
   * to be the same "one play-through" length. Falls back to the video's own
   * probed duration when no audio is loaded for this asset (most overlays,
   * since audioBalance defaults to 0 and nothing decodes their audio at all). */
  function getCanonicalOverlayDurationSeconds(assetId: string): number | null {
    const audioBuffer = videoOverlayAudioBuffersByAssetIdRef.current[assetId];
    if (audioBuffer && audioBuffer.duration > 0) return audioBuffer.duration;
    const frames = videoOverlayFramesByAssetIdRef.current[assetId];
    return frames ? frames.durationSeconds : null;
  }

  /** Draws the frame at `elapsedSeconds`, sampling only the region the
   * current crop/zoom (or a live in-progress drag override) says to keep,
   * scaled to fill the canvas -- this IS the crop, not a guide over an
   * uncropped frame. */
  function drawFrameAt(elapsedSeconds: number) {
    const canvas = canvasRef.current;
    const position = resolveSequencePosition(loadedClipsRef.current, elapsedSeconds);
    if (!canvas || !position) return;

    // A Text Slide fully replaces the frame for its own duration, same as
    // an image Cutaway -- but unlike every other clip kind, its content is
    // drawn fresh every frame (textSlideRenderer.ts's drawTextSlide, for
    // the live entrance/exit animation) rather than sourced from a
    // pre-extracted image/crop rect, so it's handled here as its own early
    // return, before any of the crop/matte/camera3D/filter machinery below
    // (none of which applies to it) ever touches `position.clipIndex`.
    const currentClipMeta = loadedClipsRef.current[position.clipIndex];
    if (currentClipMeta?.kind === "text") {
      const textEntry = textSlideEntryById.get(currentClipMeta.id ?? "");
      const ctx = canvas.getContext("2d");
      if (textEntry && ctx) {
        const { width: targetWidth, height: targetHeight } = computeOutputDimensions(outputAspectRatio);
        if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
          canvas.width = targetWidth;
          canvas.height = targetHeight;
        }
        const backgroundImage = textEntry.assetId ? (textSlideImagesRef.current[textEntry.assetId] ?? null) : null;
        drawTextSlide(ctx, textEntry, { x: 0, y: 0, width: canvas.width, height: canvas.height }, position.localSeconds, backgroundImage);
      }
      return;
    }

    const images = clipImagesRef.current[position.clipIndex];
    if (!images || images.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high"; // default "low" visibly softens/aliases every scaled drawImage below (crop/zoom, overlays)

    const frameIndex = frameIndexAtTime(position.localSeconds, frameRatesRef.current[position.clipIndex], images.length);
    const image = images[frameIndex];

    const hasAuthoredCrop = liveCropRectOverride != null || baseCropRect != null;
    const authoredCrop = liveCropRectOverride ?? (baseCropRect ? computeEffectiveCropRect(baseCropRect, zoomEffects, elapsedSeconds) : FULL_FRAME_CROP_RECT);

    // `authoredCrop` is expressed in the CURRENT clip's own aspect space
    // for an image clip's own Ken Burns motion (buildKenBurnsEffect,
    // imageTemplates.ts) -- already correctly scoped, no re-projection
    // needed -- but in the SEQUENCE's reference (first-clip) aspect space
    // for the base rect, a live drag, or any user-dragged pan/zoom
    // (applyCropRectCommit). See reprojectCropRect's own doc comment
    // (video_math.ts) for why reusing a reference-space rect verbatim
    // against a differently-shaped clip stretches instead of cropping --
    // and for why this is skipped entirely (`hasAuthoredCrop` false)
    // whenever no clip rectangle/live drag exists at all, rather than
    // reprojecting the FULL_FRAME_CROP_RECT fallback as if it meant
    // something.
    const currentClipKind = loadedClipsRef.current[position.clipIndex]?.kind;
    const clipAspectRatio = image.width / image.height;
    const referenceAspectRatio = referenceFrameSizeRef.current.width / referenceFrameSizeRef.current.height;
    const shouldReprojectForClip = hasAuthoredCrop && currentClipKind !== "image";
    const crop = shouldReprojectForClip ? reprojectCropRect(authoredCrop, referenceAspectRatio, clipAspectRatio) : authoredCrop;

    // Source rect: sampled from THIS frame's own natural size (clips can
    // have different native resolutions) -- Ken Burns zoom and clip-rect
    // cropping only ever shrink/grow THIS, never the destination below.
    const sx = crop.x * image.width;
    const sy = crop.y * image.height;
    const sWidth = crop.width * image.width;
    const sHeight = crop.height * image.height;

    // Destination (canvas) size: pinned to the project's real output
    // resolution regardless of crop/zoom/clip -- see this file's own module
    // comment on why sizing this from the crop rect instead (as before)
    // softens the preview and can flash the canvas's own aspect ratio.
    const { width: targetWidth, height: targetHeight } = computeOutputDimensions(outputAspectRatio);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    const flipHorizontal = computeEffectiveFlip(flipHorizontalToggles, elapsedSeconds);
    const flipVertical = computeEffectiveFlip(flipVerticalToggles, elapsedSeconds);

    // Two independent exclusive-overlay arrays (video vs. image) can each
    // have at most one active member, but the two CAN legitimately overlap
    // in time with each other (an edge case, not actively prevented -- see
    // this file's own module comment). When both are active at once, the
    // IMAGE one wins -- it's drawn (further below) after the video one,
    // same "graphics read as on top of video" convention the whole overlay
    // z-order follows (FrameStrip.tsx's own module comment has the full
    // rationale and the complete stack, top to bottom: text, image PiP,
    // video PiP, image exclusive, video exclusive, base).
    const activeExclusiveImageOverlay = findActiveExclusiveOverlay(overlayImages, elapsedSeconds);
    const activeExclusiveVideoOverlay = findActiveExclusiveOverlay(videoOverlays, elapsedSeconds);
    const winningExclusiveLayout = (activeExclusiveImageOverlay ?? activeExclusiveVideoOverlay)?.layout ?? null;
    const { baseRect, overlayRect } = winningExclusiveLayout
      ? computeOverlayRects(winningExclusiveLayout)
      : { baseRect: FULL_FRAME_CROP_RECT, overlayRect: null };

    // Non-null only during a cut-transition's preview window (the
    // CUT_TRANSITION_DURATION_SECONDS just before the incoming clip's own
    // real start -- see video_math.ts's resolveCutTransitionBlend doc
    // comment). KNOWN LIMITATION: skipped entirely whenever a Full-Screen/
    // Split-Screen overlay is active at the same instant -- blending TWO
    // base clips on top of an already-swapped overlay layout is a rare
    // enough combination that a hard cut there (falling back to today's
    // behavior) is an acceptable simplification rather than handling the
    // full cross-product.
    const cutTransitionBlend = winningExclusiveLayout
      ? null
      : resolveCutTransitionBlend(loadedClipsRef.current, cutTransitionById, elapsedSeconds);

    // Flip/mirror via the canvas transform, not by touching sx/sy/sWidth/
    // sHeight -- scale(-1) + translate the origin to the far edge maps the
    // same source region onto a horizontally/vertically reversed
    // destination, restored via ctx.restore() so it never leaks into the
    // next draw (this canvas is reused every frame).
    const currentEntryId = loadedClipsRef.current[position.clipIndex]?.id;
    // AI background removal (see this feature's own plan doc) -- present
    // once either the real matte or the instant MediaPipe approximation has
    // resolved for this exact frame (see the loading effect's own
    // clipMattesRef assignment); undefined for every other clip/frame,
    // which every branch below just treats as "no masking".
    const matte = clipMattesRef.current[position.clipIndex]?.[frameIndex];
    // Set true only inside the camera3D branch below -- lets the ambient-
    // effect draw after ctx.restore() know whether this frame's base clip
    // already rendered its ambient effect INSIDE that 3D scene (for real
    // parallax against the image) so it doesn't also draw a second, flat
    // copy on top.
    let baseAmbientRoutedThrough3D = false;
    ctx.save();
    ctx.filter = getFilterPresetOption(currentEntryId ? (clipFilterById.get(currentEntryId) ?? null) : null).cssFilter;
    ctx.translate(flipHorizontal ? canvas.width : 0, flipVertical ? canvas.height : 0);
    ctx.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
    if (baseRect && winningExclusiveLayout?.type === "split-screen") {
      // A Split-Screen half's own box generally has a DIFFERENT aspect
      // ratio than `crop` (the base clip's own chosen output ratio) --
      // drawing the already-cropped [sx,sy,sWidth,sHeight] region straight
      // into a differently-shaped box would non-uniformly STRETCH it
      // (drawImage maps src onto dest regardless of aspect mismatch), not
      // cleanly crop it. A further cover-fit -- using this window's own
      // baseFraming pan, independent of the overlay's own framing -- picks
      // which part of that already-cropped region survives instead.
      const baseDestX = baseRect.x * canvas.width;
      const baseDestY = baseRect.y * canvas.height;
      const baseDestWidth = baseRect.width * canvas.width;
      const baseDestHeight = baseRect.height * canvas.height;
      // `?? DEFAULT_OVERLAY_FRAMING`: baseFraming was added to the
      // split-screen layout after some projects already had one persisted
      // without it -- an old timeline (or an old undo-history snapshot
      // inside a still-open session) can hand back a split-screen layout
      // with this field simply absent, so defaulting it here (rather than
      // trusting the type) avoids a hard crash on load.
      const { panX, panY, zoom: baseZoom, flipHorizontal: baseFlipH, flipVertical: baseFlipV } = winningExclusiveLayout.baseFraming ?? DEFAULT_OVERLAY_FRAMING;
      const { sx: bsx, sy: bsy, sWidth: bsw, sHeight: bsh } = computeCoverFitSourceRect(sWidth, sHeight, baseDestWidth, baseDestHeight, panX, panY, baseZoom);
      // Composes with the global flip transform already active on this
      // context (the outer ctx.translate/scale above) -- each mirrors
      // around its own frame of reference, so both apply correctly
      // together rather than one overriding the other.
      drawImageFlipped(ctx, image, sx + bsx, sy + bsy, bsw, bsh, baseDestX, baseDestY, baseDestWidth, baseDestHeight, baseFlipH, baseFlipV);
    } else if (baseRect && currentEntryId && (matte || clipBackgroundRemovalById.get(currentEntryId))) {
      // Masked cutout over a new backdrop -- takes priority over both the
      // letterbox (next branch) and plain-crop (last branch) paths below,
      // same priority compileCreatomateTimeline.ts's buildMediaSegments
      // gives its own equivalent check, EXCEPT it defers to an active
      // Split-Screen layout (handled above) -- an orthogonal overlay
      // concept the backend never combines with canvasFillMode either, so
      // there's no real conflict to resolve there, only here in the
      // preview's own branch ordering.
      //
      // No canvasFillMode of "crop" makes sense once the subject is cut
      // out (there must be SOME backdrop) -- defaults to solid
      // DEFAULT_CANVAS_FILL_COLOR, same fallback
      // compileCreatomateTimeline.ts's buildBackgroundRemovedSegment uses,
      // so the preview and the real render agree on the default backdrop.
      const rawFill = clipCanvasFillById.get(currentEntryId) ?? { mode: "crop" as const };
      const fill = rawFill.mode === "crop" ? { mode: "solid" as const, color: DEFAULT_CANVAS_FILL_COLOR, gradientColor: undefined as string | undefined } : rawFill;
      const canvasAspectRatio = canvas.width / canvas.height;
      const baseCssFilter = ctx.filter;
      if (fill.mode === "blur") {
        const bgCrop = computeMaxCoverageCropRect(image.width, image.height, canvasAspectRatio);
        const blurRadiusPx = CANVAS_FILL_BLUR_RADIUS_FRACTION * Math.max(canvas.width, canvas.height);
        ctx.filter = `${baseCssFilter === "none" ? "" : baseCssFilter} blur(${blurRadiusPx}px)`.trim();
        ctx.drawImage(image, bgCrop.x, bgCrop.y, bgCrop.width, bgCrop.height, 0, 0, canvas.width, canvas.height);
        ctx.filter = baseCssFilter;
      } else {
        ctx.filter = "none";
        if (fill.mode === "solid") {
          ctx.fillStyle = fill.color ?? DEFAULT_CANVAS_FILL_COLOR;
        } else {
          const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
          gradient.addColorStop(0, fill.color ?? DEFAULT_CANVAS_FILL_COLOR);
          gradient.addColorStop(1, fill.gradientColor ?? DEFAULT_CANVAS_FILL_GRADIENT_COLOR);
          ctx.fillStyle = gradient;
        }
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.filter = baseCssFilter;
      }

      const destX = baseRect.x * canvas.width;
      const destY = baseRect.y * canvas.height;
      const destWidth = baseRect.width * canvas.width;
      const destHeight = baseRect.height * canvas.height;

      if (matte) {
        // VIDEO path: draw the cropped subject onto a scratch canvas, then
        // punch it down to just the matte's alpha via "destination-in"
        // (Porter-Duff DestIn -- keeps the destination scaled by the
        // SOURCE's alpha only, its own RGB is never read, see
        // backgroundSegmentation.ts's own module comment) before
        // compositing that onto the real canvas, on top of the backdrop
        // just drawn -- the client-side equivalent of Creatomate's real
        // maskMode: "luma".
        if (
          maskCompositeCanvasRef.current === null ||
          maskCompositeCanvasRef.current.width !== canvas.width ||
          maskCompositeCanvasRef.current.height !== canvas.height
        ) {
          maskCompositeCanvasRef.current = document.createElement("canvas");
          maskCompositeCanvasRef.current.width = canvas.width;
          maskCompositeCanvasRef.current.height = canvas.height;
        }
        const maskCanvas = maskCompositeCanvasRef.current;
        const maskCtx = maskCanvas.getContext("2d");
        if (maskCtx) {
          maskCtx.imageSmoothingQuality = "high"; // keep matte edges as smooth as the base frame they composite against
          // `crop` is a FRACTION of the frame (0..1) -- reapplied against
          // the matte's own width/height, not image's sx/sy/sWidth/sHeight
          // verbatim, since the matte (a MediaPipe mask or VEED's own
          // output) isn't guaranteed to share the source video's exact
          // pixel dimensions.
          const matteSx = crop.x * matte.width;
          const matteSy = crop.y * matte.height;
          const matteSWidth = crop.width * matte.width;
          const matteSHeight = crop.height * matte.height;
          maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
          maskCtx.globalCompositeOperation = "source-over";
          maskCtx.drawImage(image, sx, sy, sWidth, sHeight, destX, destY, destWidth, destHeight);
          maskCtx.globalCompositeOperation = "destination-in";
          maskCtx.drawImage(matte, matteSx, matteSy, matteSWidth, matteSHeight, destX, destY, destWidth, destHeight);
          ctx.drawImage(maskCanvas, 0, 0);
        }
      } else {
        // IMAGE path (Ken Burns cutaway): no separate mask element needed
        // at all -- `image` here is already the transparent cutout itself
        // (real rembg alpha, or MediaPipe's approximate one, see the
        // loading effect's own image branch), so a plain drawImage on top
        // of the backdrop just drawn above lets its own per-pixel alpha
        // show that backdrop through natively, no scratch canvas required.
        ctx.drawImage(image, sx, sy, sWidth, sHeight, destX, destY, destWidth, destHeight);
      }
    } else if (baseRect && currentEntryId && (clipCanvasFillById.get(currentEntryId)?.mode ?? "crop") !== "crop") {
      // Letterboxed/pillarboxed instead of cropped -- the clip's full,
      // uncropped frame shown centered (computeContainFitRect), with the
      // empty bars filled by a blurred cover-fit duplicate / solid color /
      // gradient behind it (see canvasFillPresets.ts). Only reachable here,
      // never in the Split-Screen branch above -- same scope limit as this
      // file's own module comment on other compound edge cases.
      const fill = clipCanvasFillById.get(currentEntryId)!;
      const canvasAspectRatio = canvas.width / canvas.height;
      const baseCssFilter = ctx.filter; // already this clip's own color filter, set above
      if (fill.mode === "blur") {
        // Cover-fit of the FULL native frame (not the authored crop -- the
        // backdrop is always full-bleed decoration, independent of any
        // crop/zoom this clip's own canvasFillMode already bypasses).
        const bgCrop = computeMaxCoverageCropRect(image.width, image.height, canvasAspectRatio);
        const blurRadiusPx = CANVAS_FILL_BLUR_RADIUS_FRACTION * Math.max(canvas.width, canvas.height);
        ctx.filter = `${baseCssFilter === "none" ? "" : baseCssFilter} blur(${blurRadiusPx}px)`.trim();
        ctx.drawImage(image, bgCrop.x, bgCrop.y, bgCrop.width, bgCrop.height, 0, 0, canvas.width, canvas.height);
      } else {
        ctx.filter = "none";
        if (fill.mode === "solid") {
          ctx.fillStyle = fill.color ?? DEFAULT_CANVAS_FILL_COLOR;
        } else {
          const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
          gradient.addColorStop(0, fill.color ?? DEFAULT_CANVAS_FILL_COLOR);
          gradient.addColorStop(1, fill.gradientColor ?? DEFAULT_CANVAS_FILL_GRADIENT_COLOR);
          ctx.fillStyle = gradient;
        }
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.filter = baseCssFilter;
      const containRect = computeContainFitRect(clipAspectRatio, canvasAspectRatio);
      ctx.drawImage(
        image, 0, 0, image.width, image.height,
        containRect.x * canvas.width, containRect.y * canvas.height, containRect.width * canvas.width, containRect.height * canvas.height
      );
    } else if (baseRect) {
      // null only for an active Full-Screen video overlay -- the overlay's
      // own draw below fully covers the canvas at full opacity regardless,
      // so skipping this is a pure optimization, never load-bearing for
      // correctness (see video_math.ts's computeOverlayRects doc comment).
      // Not Split-Screen here, so baseRect always matches crop's own
      // aspect (the full canvas) -- no further cover-fit needed.
      // "Pulse with music" (audioReactive.ts) -- scales the dest rect around
      // its own center to the background track's amplitude at this instant,
      // independent of/composes with the camera3D branch below (both take
      // the same four dest args either way).
      const basePulseScale =
        currentEntryId && clipAudioReactiveById.get(currentEntryId)
          ? audioReactiveScale(sampleMusicClipsEnvelopeAt(musicClips, musicEnvelopesByAssetIdRef.current, elapsedSeconds))
          : 1;
      const baseDestRect =
        basePulseScale !== 1
          ? scaleCropRectCentered({ x: baseRect.x * canvas.width, y: baseRect.y * canvas.height, width: baseRect.width * canvas.width, height: baseRect.height * canvas.height }, basePulseScale)
          : { x: baseRect.x * canvas.width, y: baseRect.y * canvas.height, width: baseRect.width * canvas.width, height: baseRect.height * canvas.height };
      const destX = baseDestRect.x;
      const destY = baseDestRect.y;
      const destWidth = baseDestRect.width;
      const destHeight = baseDestRect.height;
      // "Make it 3D" (camera3D.ts) -- only for a Ken Burns image cutaway
      // with an active ZoomEffect at this instant (the effect IS the dolly
      // this rides -- see applyAddImageSequenceClip, which bakes a Ken
      // Burns motion straight into the shared zoomEffects array). Flip is
      // already applied via the outer ctx.translate/scale above, so both
      // flip args here are false -- passing the real toggles too would
      // flip it twice.
      const activeZoomEffectIndex = currentEntryId && clipCamera3DById.get(currentEntryId) ? findActiveZoomEffectIndex(zoomEffects, elapsedSeconds) : -1;
      const baseAmbientEffectId = currentEntryId ? clipAmbientEffectById.get(currentEntryId) : undefined;
      // Face-locked glow (faceLandmarks.ts + camera3D.ts's halo/torus) --
      // unlike camera3D above, this doesn't ride the clip's own ZoomEffect
      // (it has no dolly of its own to time), so it routes through the same
      // shared 3D scene via a static NEUTRAL_POSE whenever camera3D itself
      // isn't ALSO driving a real pose this instant.
      const baseFaceEffectId = currentEntryId ? clipFaceEffectById.get(currentEntryId) : null;
      if (activeZoomEffectIndex !== -1 || baseFaceEffectId) {
        const pose =
          activeZoomEffectIndex !== -1
            ? computeCamera3DPoseForZoomEffect(zoomEffects[activeZoomEffectIndex], clipTemplateIdsById.get(currentEntryId!) ?? [], elapsedSeconds)
            : NEUTRAL_POSE;
        const baseFaceGeometry = clipFaceGeometriesRef.current[position.clipIndex] ?? null;
        getCamera3DRenderer().drawImage3D(
          ctx, image, pose, sx, sy, sWidth, sHeight, destX, destY, destWidth, destHeight, false, false,
          baseAmbientEffectId ? { effectId: baseAmbientEffectId, elapsedSeconds: position.localSeconds, seed: ambientEffectSeed(currentEntryId!) } : null,
          clipCamera3DSubjectCutoutsRef.current[position.clipIndex] ?? null,
          baseFaceEffectId && baseFaceGeometry ? { effectId: baseFaceEffectId, geometry: baseFaceGeometry, elapsedSeconds: position.localSeconds } : null
        );
        baseAmbientRoutedThrough3D = Boolean(baseAmbientEffectId);
      } else {
        ctx.drawImage(image, sx, sy, sWidth, sHeight, destX, destY, destWidth, destHeight);
      }
    }
    ctx.restore();

    // Ambient overlay effect (ambientEffects.ts) -- drawn AFTER ctx.restore()
    // (outside the flip transform, same reasoning as every other overlay
    // below) so it's never mirrored along with the footage. `baseRect` is
    // whatever this frame's base clip actually filled (its own full frame,
    // or its own half of a Split-Screen layout) regardless of which branch
    // above drew it -- independent of camera3D/canvasFillMode/background
    // removal. `position.localSeconds` is time since THIS clip's own start,
    // so the effect's own loop is self-contained per clip. Skipped when
    // camera3D already rendered this same effect INSIDE its 3D scene above
    // (baseAmbientRoutedThrough3D) -- that's what gives it real parallax
    // against the image instead of sitting on top like a flat sticker.
    if (baseRect && currentEntryId && !baseAmbientRoutedThrough3D && clipAmbientEffectById.get(currentEntryId)) {
      drawAmbientEffect(
        ctx,
        clipAmbientEffectById.get(currentEntryId),
        baseRect.x * canvas.width,
        baseRect.y * canvas.height,
        baseRect.width * canvas.width,
        baseRect.height * canvas.height,
        position.localSeconds,
        ambientEffectSeed(currentEntryId)
      );
    }

    // The incoming side of a cut-transition blend -- drawn as its own
    // independent save/restore (not nested inside the outgoing clip's own
    // flip transform above) since the incoming clip can have a different
    // filter and its own flip state. A live-preview APPROXIMATION of
    // Creatomate's real Fade/SlideLeft/WipeLeft animation classes, same
    // "closest same-primitives match available in a 2D canvas" spirit as
    // filterPresets.ts's own cssFilter disclaimer -- not pixel-identical to
    // the real render. Only drawn into the simple (non-Split-Screen)
    // baseRect case, same scope as cutTransitionBlend's own doc comment.
    if (cutTransitionBlend && baseRect && winningExclusiveLayout?.type !== "split-screen") {
      const incomingImages = clipImagesRef.current[cutTransitionBlend.toIndex];
      const incomingEntryId = loadedClipsRef.current[cutTransitionBlend.toIndex]?.id;
      const incomingCutTransitionId = incomingEntryId ? cutTransitionById.get(incomingEntryId) ?? null : null;
      if (incomingImages && incomingImages.length > 0) {
        const incomingFrameIndex = frameIndexAtTime(
          cutTransitionBlend.toLocalSeconds,
          frameRatesRef.current[cutTransitionBlend.toIndex],
          incomingImages.length
        );
        const incomingImage = incomingImages[incomingFrameIndex];
        // The same absolute instant this preview will actually occupy once
        // real playback reaches it (elapsedSeconds is still PRE-boundary
        // here) -- evaluating crop/flip against this synthetic time, not the
        // real elapsedSeconds, means a ZoomEffect/flip toggle authored to
        // start exactly at the cut previews correctly too.
        const incomingSyntheticElapsed = elapsedSeconds + cutTransitionBlend.overlapSeconds;
        const authoredIncomingCrop =
          liveCropRectOverride ?? (baseCropRect ? computeEffectiveCropRect(baseCropRect, zoomEffects, incomingSyntheticElapsed) : FULL_FRAME_CROP_RECT);
        // Same re-projection rule as the outgoing clip's own `crop` above.
        const incomingClipKind = loadedClipsRef.current[cutTransitionBlend.toIndex]?.kind;
        const incomingCrop =
          !hasAuthoredCrop || incomingClipKind === "image"
            ? authoredIncomingCrop
            : reprojectCropRect(authoredIncomingCrop, referenceAspectRatio, incomingImage.width / incomingImage.height);
        const incomingSx = incomingCrop.x * incomingImage.width;
        const incomingSy = incomingCrop.y * incomingImage.height;
        const incomingSWidth = incomingCrop.width * incomingImage.width;
        const incomingSHeight = incomingCrop.height * incomingImage.height;
        const incomingFlipH = computeEffectiveFlip(flipHorizontalToggles, incomingSyntheticElapsed);
        const incomingFlipV = computeEffectiveFlip(flipVerticalToggles, incomingSyntheticElapsed);
        const destX = baseRect.x * canvas.width;
        const destY = baseRect.y * canvas.height;
        const destWidth = baseRect.width * canvas.width;
        const destHeight = baseRect.height * canvas.height;

        ctx.save();
        ctx.filter = getFilterPresetOption(incomingEntryId ? (clipFilterById.get(incomingEntryId) ?? null) : null).cssFilter;
        if (incomingCutTransitionId === "wipe") {
          // Reveal grows left-to-right -- an approximation of WipeLeft's own
          // geometry, not a literal match (see this block's own comment).
          ctx.beginPath();
          ctx.rect(destX, destY, destWidth * cutTransitionBlend.progress, destHeight);
          ctx.clip();
        } else if (incomingCutTransitionId === "slide") {
          // Slides in from the right, covering the outgoing frame
          // underneath -- a "push" reveal, not a true dual-slide (the
          // outgoing frame itself doesn't also slide out).
        } else {
          // "fade" (or an unset/legacy id defaulting to it).
          ctx.globalAlpha = cutTransitionBlend.progress;
        }
        const slideOffsetX = incomingCutTransitionId === "slide" ? (1 - cutTransitionBlend.progress) * destWidth : 0;
        drawImageFlipped(
          ctx, incomingImage, incomingSx, incomingSy, incomingSWidth, incomingSHeight,
          destX + slideOffsetX, destY, destWidth, destHeight, incomingFlipH, incomingFlipV
        );
        ctx.restore();
      }
    }

    // Composited AFTER the flip transform is undone (ctx.restore() above)
    // -- an overlay (image or video) is independent of the base clip's flip
    // state, not something that should mirror along with it. Full-Screen
    // fills the whole canvas (covering the skipped/undrawn base above);
    // Split Screen fills its own half. Image wins over video when both are
    // active (see this function's own comment above on winningExclusiveLayout).
    if (activeExclusiveImageOverlay && overlayRect) {
      // Background removal (AI/chroma-key) replaces the plain photo outright
      // with an already-transparent cutout -- see
      // imageOverlayCutoutsByAssetIdRef's own loading-effect comment for why
      // this mirrors the base sequence's still-image cutaway path rather
      // than a separate alpha-mask layer.
      const overlayImage =
        (activeExclusiveImageOverlay.backgroundRemoval?.enabled && imageOverlayCutoutsByAssetIdRef.current[activeExclusiveImageOverlay.assetId]) ||
        overlayImagesRef.current[activeExclusiveImageOverlay.assetId];
      if (overlayImage) {
        const destX = overlayRect.x * canvas.width;
        const destY = overlayRect.y * canvas.height;
        const destWidth = overlayRect.width * canvas.width;
        const destHeight = overlayRect.height * canvas.height;
        const { sx: osx, sy: osy, sWidth: osw, sHeight: osh } = computeCoverFitSourceRect(
          overlayImage.width, overlayImage.height, destWidth, destHeight,
          activeExclusiveImageOverlay.framing.panX, activeExclusiveImageOverlay.framing.panY, activeExclusiveImageOverlay.framing.zoom
        );
        ctx.filter = getFilterPresetOption(activeExclusiveImageOverlay.colorFilterId ?? null).cssFilter;
        // "Pulse with music" -- pulses only the image draw below, not the
        // ambientEffect draw further down (which keeps using the original
        // unpulsed destX/destY/destWidth/destHeight).
        const imageOverlayPulseScale = activeExclusiveImageOverlay.audioReactive
          ? audioReactiveScale(sampleMusicClipsEnvelopeAt(musicClips, musicEnvelopesByAssetIdRef.current, elapsedSeconds))
          : 1;
        const imageOverlayDestRect =
          imageOverlayPulseScale !== 1
            ? scaleCropRectCentered({ x: destX, y: destY, width: destWidth, height: destHeight }, imageOverlayPulseScale)
            : { x: destX, y: destY, width: destWidth, height: destHeight };
        if (activeExclusiveImageOverlay.camera3D || activeExclusiveImageOverlay.faceEffect) {
          // Same synthesized-dolly "Make it 3D" as the PiP overlay loops
          // below -- a Split-Screen half tilting in 3D can reveal a sliver
          // of whatever's behind it at its foreshortened edge (there's
          // nothing else in that half to show through to), same graceful
          // "floating card" fallback camera3D.ts's own renderer documents.
          // A faceEffect alone (camera3D off) uses a static NEUTRAL_POSE --
          // see that constant's own comment.
          const pose = activeExclusiveImageOverlay.camera3D
            ? computeCamera3DPoseForOverlay(activeExclusiveImageOverlay.startTimeSeconds, activeExclusiveImageOverlay.endTimeSeconds, elapsedSeconds)
            : NEUTRAL_POSE;
          const overlayFaceGeometry = overlayFaceGeometriesRef.current[activeExclusiveImageOverlay.assetId] ?? null;
          getCamera3DRenderer().drawImage3D(
            ctx, overlayImage, pose, osx, osy, osw, osh, imageOverlayDestRect.x, imageOverlayDestRect.y, imageOverlayDestRect.width, imageOverlayDestRect.height,
            activeExclusiveImageOverlay.framing.flipHorizontal, activeExclusiveImageOverlay.framing.flipVertical,
            activeExclusiveImageOverlay.ambientEffect
              ? {
                  effectId: activeExclusiveImageOverlay.ambientEffect,
                  elapsedSeconds: elapsedSeconds - activeExclusiveImageOverlay.startTimeSeconds,
                  seed: ambientEffectSeed(activeExclusiveImageOverlay.startTimeSeconds),
                }
              : null,
            null,
            activeExclusiveImageOverlay.faceEffect && overlayFaceGeometry
              ? { effectId: activeExclusiveImageOverlay.faceEffect, geometry: overlayFaceGeometry, elapsedSeconds: elapsedSeconds - activeExclusiveImageOverlay.startTimeSeconds }
              : null
          );
        } else {
          drawImageFlipped(
            ctx, overlayImage, osx, osy, osw, osh, imageOverlayDestRect.x, imageOverlayDestRect.y, imageOverlayDestRect.width, imageOverlayDestRect.height,
            activeExclusiveImageOverlay.framing.flipHorizontal, activeExclusiveImageOverlay.framing.flipVertical
          );
        }
        ctx.filter = "none";
        // Skipped when camera3D above already rendered this effect inside
        // its own 3D scene (real parallax) -- see that branch's own comment.
        if (activeExclusiveImageOverlay.ambientEffect && !activeExclusiveImageOverlay.camera3D) {
          drawAmbientEffect(
            ctx, activeExclusiveImageOverlay.ambientEffect, destX, destY, destWidth, destHeight,
            elapsedSeconds - activeExclusiveImageOverlay.startTimeSeconds, ambientEffectSeed(activeExclusiveImageOverlay.startTimeSeconds)
          );
        }
      }
    } else if (activeExclusiveVideoOverlay && overlayRect) {
      const frames = videoOverlayFramesByAssetIdRef.current[activeExclusiveVideoOverlay.assetId];
      if (frames) {
        const localOffsetSeconds = activeExclusiveVideoOverlay.sourceStartSeconds + (elapsedSeconds - activeExclusiveVideoOverlay.startTimeSeconds);
        // Loops back to the start once the window runs past one
        // play-through of the source (see VideoOverlayTrack.tsx's own
        // edge-drag comment) -- frameIndexAtTime alone would just clamp to
        // the last frame and freeze there instead. Uses the canonical
        // duration (prefers decoded audio's exact length over the video's
        // own probed estimate) so video looping never drifts from audio
        // looping over repeated play-throughs -- see
        // getCanonicalOverlayDurationSeconds.
        const canonicalDurationSeconds = getCanonicalOverlayDurationSeconds(activeExclusiveVideoOverlay.assetId) ?? frames.durationSeconds;
        const loopedOffsetSeconds = canonicalDurationSeconds > 0 ? localOffsetSeconds % canonicalDurationSeconds : localOffsetSeconds;
        const overlayFrameIndex = frameIndexAtTime(loopedOffsetSeconds, frames.frameRate, frames.images.length);
        const overlayImage = frames.images[overlayFrameIndex];
        const destX = overlayRect.x * canvas.width;
        const destY = overlayRect.y * canvas.height;
        const destWidth = overlayRect.width * canvas.width;
        const destHeight = overlayRect.height * canvas.height;
        const { sx: osx, sy: osy, sWidth: osw, sHeight: osh } = computeCoverFitSourceRect(
          overlayImage.width, overlayImage.height, destWidth, destHeight,
          activeExclusiveVideoOverlay.framing.panX, activeExclusiveVideoOverlay.framing.panY, activeExclusiveVideoOverlay.framing.zoom
        );
        ctx.filter = getFilterPresetOption(activeExclusiveVideoOverlay.colorFilterId ?? null).cssFilter;
        const overlayMattes = activeExclusiveVideoOverlay.backgroundRemoval?.enabled
          ? videoOverlayMattesByAssetIdRef.current[activeExclusiveVideoOverlay.assetId]
          : undefined;
        // Set true only inside the camera3D branch below -- see the
        // ambientEffect check after ctx.filter = "none" further down.
        let videoOverlayAmbientRoutedThrough3D = false;
        if (overlayMattes && overlayMattes.length > 0) {
          // Same proportional-fraction mapping onto the matte's own pixel
          // dimensions as the base clip's crop-fraction path above -- an
          // overlay has no separate `crop` fraction of its own, so this is
          // derived directly from osx/osy/osw/osh (already computed against
          // overlayImage's pixel space by computeCoverFitSourceRect).
          const matte = overlayMattes[Math.min(overlayFrameIndex, overlayMattes.length - 1)];
          drawImageFlippedMasked(
            ctx, getMaskCanvas(canvas.width, canvas.height), overlayImage, matte,
            osx, osy, osw, osh,
            (osx / overlayImage.width) * matte.width, (osy / overlayImage.height) * matte.height,
            (osw / overlayImage.width) * matte.width, (osh / overlayImage.height) * matte.height,
            destX, destY, destWidth, destHeight,
            activeExclusiveVideoOverlay.framing.flipHorizontal, activeExclusiveVideoOverlay.framing.flipVertical
          );
        } else if (activeExclusiveVideoOverlay.camera3D) {
          // "Pulse with music" -- only in this and the plain-draw branch
          // below, same "matte compositing wins" scoping as camera3D itself
          // (the masked branch above never pulses either).
          const pose = computeCamera3DPoseForOverlay(activeExclusiveVideoOverlay.startTimeSeconds, activeExclusiveVideoOverlay.endTimeSeconds, elapsedSeconds);
          const videoOverlayPulseScale = activeExclusiveVideoOverlay.audioReactive
            ? audioReactiveScale(sampleMusicClipsEnvelopeAt(musicClips, musicEnvelopesByAssetIdRef.current, elapsedSeconds))
            : 1;
          const videoOverlayDestRect =
            videoOverlayPulseScale !== 1
              ? scaleCropRectCentered({ x: destX, y: destY, width: destWidth, height: destHeight }, videoOverlayPulseScale)
              : { x: destX, y: destY, width: destWidth, height: destHeight };
          getCamera3DRenderer().drawImage3D(
            ctx, overlayImage, pose, osx, osy, osw, osh, videoOverlayDestRect.x, videoOverlayDestRect.y, videoOverlayDestRect.width, videoOverlayDestRect.height,
            activeExclusiveVideoOverlay.framing.flipHorizontal, activeExclusiveVideoOverlay.framing.flipVertical,
            activeExclusiveVideoOverlay.ambientEffect
              ? {
                  effectId: activeExclusiveVideoOverlay.ambientEffect,
                  elapsedSeconds: elapsedSeconds - activeExclusiveVideoOverlay.startTimeSeconds,
                  seed: ambientEffectSeed(activeExclusiveVideoOverlay.startTimeSeconds),
                }
              : null
          );
          videoOverlayAmbientRoutedThrough3D = Boolean(activeExclusiveVideoOverlay.ambientEffect);
        } else {
          const videoOverlayPulseScale = activeExclusiveVideoOverlay.audioReactive
            ? audioReactiveScale(sampleMusicClipsEnvelopeAt(musicClips, musicEnvelopesByAssetIdRef.current, elapsedSeconds))
            : 1;
          const videoOverlayDestRect =
            videoOverlayPulseScale !== 1
              ? scaleCropRectCentered({ x: destX, y: destY, width: destWidth, height: destHeight }, videoOverlayPulseScale)
              : { x: destX, y: destY, width: destWidth, height: destHeight };
          drawImageFlipped(
            ctx, overlayImage, osx, osy, osw, osh, videoOverlayDestRect.x, videoOverlayDestRect.y, videoOverlayDestRect.width, videoOverlayDestRect.height,
            activeExclusiveVideoOverlay.framing.flipHorizontal, activeExclusiveVideoOverlay.framing.flipVertical
          );
        }
        ctx.filter = "none";
        if (activeExclusiveVideoOverlay.ambientEffect && !videoOverlayAmbientRoutedThrough3D) {
          drawAmbientEffect(
            ctx, activeExclusiveVideoOverlay.ambientEffect, destX, destY, destWidth, destHeight,
            elapsedSeconds - activeExclusiveVideoOverlay.startTimeSeconds, ambientEffectSeed(activeExclusiveVideoOverlay.startTimeSeconds)
          );
        }
        if (isVideoOverlayMattePending(activeExclusiveVideoOverlay.backgroundRemoval, overlayMattes)) {
          drawBackgroundRemovalSpinnerBadge(ctx, destX, destY, destWidth, destHeight, elapsedSeconds);
        }
      }
    }

    // Picture-in-Picture VIDEO overlays float on top of whatever's showing
    // (the base clip, or an active Full-Screen/Split-Screen overlay above)
    // -- unlike the exclusive layouts, any number can be active at once.
    for (const pip of findActivePictureInPictureOverlays(videoOverlays, elapsedSeconds)) {
      if (pip.layout.type !== "picture-in-picture") continue; // narrows the type for pip.layout.rect below
      const frames = videoOverlayFramesByAssetIdRef.current[pip.assetId];
      if (!frames) {
        // Source frames haven't been extracted yet -- without this the pip
        // is simply invisible (see drawPipLoadingPlaceholder's own comment).
        drawPipLoadingPlaceholder(
          ctx,
          pip.layout.rect.x * canvas.width, pip.layout.rect.y * canvas.height,
          pip.layout.rect.width * canvas.width, pip.layout.rect.height * canvas.height,
          elapsedSeconds
        );
        continue;
      }
      const localOffsetSeconds = pip.sourceStartSeconds + (elapsedSeconds - pip.startTimeSeconds);
      // See the exclusive-overlay branch above for why this prefers the
      // canonical (audio-derived, when available) duration over the video's
      // own probed one.
      const canonicalDurationSeconds = getCanonicalOverlayDurationSeconds(pip.assetId) ?? frames.durationSeconds;
      const loopedOffsetSeconds = canonicalDurationSeconds > 0 ? localOffsetSeconds % canonicalDurationSeconds : localOffsetSeconds;
      const pipFrameIndex = frameIndexAtTime(loopedOffsetSeconds, frames.frameRate, frames.images.length);
      const pipImage = frames.images[pipFrameIndex];
      const destX = pip.layout.rect.x * canvas.width;
      const destY = pip.layout.rect.y * canvas.height;
      const destWidth = pip.layout.rect.width * canvas.width;
      const destHeight = pip.layout.rect.height * canvas.height;
      const { sx: psx, sy: psy, sWidth: psw, sHeight: psh } = computeCoverFitSourceRect(
        pipImage.width, pipImage.height, destWidth, destHeight, pip.framing.panX, pip.framing.panY, pip.framing.zoom, MIN_PICTURE_IN_PICTURE_ZOOM
      );
      ctx.filter = getFilterPresetOption(pip.colorFilterId ?? null).cssFilter;
      const pipMattes = pip.backgroundRemoval?.enabled ? videoOverlayMattesByAssetIdRef.current[pip.assetId] : undefined;
      // Set true only inside the camera3D sub-branch below -- see the
      // ambientEffect check after ctx.filter = "none" further down.
      let pipVideoAmbientRoutedThrough3D = false;
      if (pipMattes && pipMattes.length > 0) {
        // Same proportional mapping as the exclusive-overlay branch above.
        const matte = pipMattes[Math.min(pipFrameIndex, pipMattes.length - 1)];
        drawImageFlippedMasked(
          ctx, getMaskCanvas(canvas.width, canvas.height), pipImage, matte,
          psx, psy, psw, psh,
          (psx / pipImage.width) * matte.width, (psy / pipImage.height) * matte.height,
          (psw / pipImage.width) * matte.width, (psh / pipImage.height) * matte.height,
          destX, destY, destWidth, destHeight,
          pip.framing.flipHorizontal, pip.framing.flipVertical
        );
      } else {
        // "Pulse with music" -- only in this (camera3D or plain) branch,
        // same "matte compositing wins" scoping as camera3D itself.
        const pipPulseScale = pip.audioReactive
          ? audioReactiveScale(sampleMusicClipsEnvelopeAt(musicClips, musicEnvelopesByAssetIdRef.current, elapsedSeconds))
          : 1;
        const pipDestRect =
          pipPulseScale !== 1
            ? scaleCropRectCentered({ x: destX, y: destY, width: destWidth, height: destHeight }, pipPulseScale)
            : { x: destX, y: destY, width: destWidth, height: destHeight };
        if (pip.camera3D) {
          // "Make it 3D" (camera3D.ts) -- an overlay has no keyframed pan/zoom
          // timeline to ride (see OverlayFraming's own doc comment), so the
          // dolly is synthesized as one fixed push across the overlay's own
          // start->end window rather than riding an existing effect.
          const pose = computeCamera3DPoseForOverlay(pip.startTimeSeconds, pip.endTimeSeconds, elapsedSeconds);
          getCamera3DRenderer().drawImage3D(
            ctx, pipImage, pose, psx, psy, psw, psh, pipDestRect.x, pipDestRect.y, pipDestRect.width, pipDestRect.height, pip.framing.flipHorizontal, pip.framing.flipVertical,
            pip.ambientEffect ? { effectId: pip.ambientEffect, elapsedSeconds: elapsedSeconds - pip.startTimeSeconds, seed: ambientEffectSeed(pip.startTimeSeconds) } : null
          );
          pipVideoAmbientRoutedThrough3D = Boolean(pip.ambientEffect);
        } else {
          drawImageFlipped(
            ctx, pipImage, psx, psy, psw, psh, pipDestRect.x, pipDestRect.y, pipDestRect.width, pipDestRect.height, pip.framing.flipHorizontal, pip.framing.flipVertical
          );
        }
      }
      ctx.filter = "none";
      if (pip.ambientEffect && !pipVideoAmbientRoutedThrough3D) {
        drawAmbientEffect(ctx, pip.ambientEffect, destX, destY, destWidth, destHeight, elapsedSeconds - pip.startTimeSeconds, ambientEffectSeed(pip.startTimeSeconds));
      }
      if (isVideoOverlayMattePending(pip.backgroundRemoval, pipMattes)) {
        drawBackgroundRemovalSpinnerBadge(ctx, destX, destY, destWidth, destHeight, elapsedSeconds);
      }
    }

    // Picture-in-Picture IMAGE overlays draw AFTER video PiP overlays, so
    // an image PiP wins visually if it happens to overlap a video PiP box
    // -- same "image wins" convention as the exclusive layer above.
    for (const pip of findActivePictureInPictureOverlays(overlayImages, elapsedSeconds)) {
      if (pip.layout.type !== "picture-in-picture") continue; // narrows the type for pip.layout.rect below
      const overlayImage =
        (pip.backgroundRemoval?.enabled && imageOverlayCutoutsByAssetIdRef.current[pip.assetId]) || overlayImagesRef.current[pip.assetId];
      if (!overlayImage) continue;
      const destX = pip.layout.rect.x * canvas.width;
      const destY = pip.layout.rect.y * canvas.height;
      const destWidth = pip.layout.rect.width * canvas.width;
      const destHeight = pip.layout.rect.height * canvas.height;
      const { sx: psx, sy: psy, sWidth: psw, sHeight: psh } = computeCoverFitSourceRect(
        overlayImage.width, overlayImage.height, destWidth, destHeight, pip.framing.panX, pip.framing.panY, pip.framing.zoom, MIN_PICTURE_IN_PICTURE_ZOOM
      );
      ctx.filter = getFilterPresetOption(pip.colorFilterId ?? null).cssFilter;
      // "Pulse with music" -- same treatment as the video-overlay PiP loop
      // above, independent of camera3D/ambientEffect.
      const imagePipPulseScale = pip.audioReactive
        ? audioReactiveScale(sampleMusicClipsEnvelopeAt(musicClips, musicEnvelopesByAssetIdRef.current, elapsedSeconds))
        : 1;
      const imagePipDestRect =
        imagePipPulseScale !== 1
          ? scaleCropRectCentered({ x: destX, y: destY, width: destWidth, height: destHeight }, imagePipPulseScale)
          : { x: destX, y: destY, width: destWidth, height: destHeight };
      if (pip.camera3D || pip.faceEffect) {
        // Same "Make it 3D" synthesized dolly as the video-overlay PiP loop
        // above. A faceEffect alone (camera3D off) uses a static
        // NEUTRAL_POSE -- see that constant's own comment.
        const pose = pip.camera3D ? computeCamera3DPoseForOverlay(pip.startTimeSeconds, pip.endTimeSeconds, elapsedSeconds) : NEUTRAL_POSE;
        const pipFaceGeometry = overlayFaceGeometriesRef.current[pip.assetId] ?? null;
        getCamera3DRenderer().drawImage3D(
          ctx, overlayImage, pose, psx, psy, psw, psh, imagePipDestRect.x, imagePipDestRect.y, imagePipDestRect.width, imagePipDestRect.height, pip.framing.flipHorizontal, pip.framing.flipVertical,
          pip.ambientEffect ? { effectId: pip.ambientEffect, elapsedSeconds: elapsedSeconds - pip.startTimeSeconds, seed: ambientEffectSeed(pip.startTimeSeconds) } : null,
          null,
          pip.faceEffect && pipFaceGeometry ? { effectId: pip.faceEffect, geometry: pipFaceGeometry, elapsedSeconds: elapsedSeconds - pip.startTimeSeconds } : null
        );
      } else {
        drawImageFlipped(
          ctx, overlayImage, psx, psy, psw, psh, imagePipDestRect.x, imagePipDestRect.y, imagePipDestRect.width, imagePipDestRect.height, pip.framing.flipHorizontal, pip.framing.flipVertical
        );
      }
      ctx.filter = "none";
      if (pip.ambientEffect && !pip.camera3D) {
        drawAmbientEffect(ctx, pip.ambientEffect, destX, destY, destWidth, destHeight, elapsedSeconds - pip.startTimeSeconds, ambientEffectSeed(pip.startTimeSeconds));
      }
    }

    // Text overlays draw last, always on top of every overlay above.
    for (const overlay of findActiveTextOverlays(textOverlays, elapsedSeconds)) {
      const renderer = getTextTemplateRenderer(overlay.templateId);
      if (!renderer) continue;
      renderer({
        ctx,
        text: overlay.text,
        rectPx: {
          x: overlay.rect.x * canvas.width,
          y: overlay.rect.y * canvas.height,
          width: overlay.rect.width * canvas.width,
          height: overlay.rect.height * canvas.height,
        },
        progress: computeProgress(overlay.startTimeSeconds, overlay.endTimeSeconds, elapsedSeconds),
      });
    }

    // TTS narration captions draw last of all -- on top of manually-typed
    // text overlays too, since narration is the most "live" caption layer.
    for (const overlay of findActiveTtsOverlays(ttsOverlays, elapsedSeconds)) {
      const rectPx = {
        x: overlay.rect.x * canvas.width,
        y: overlay.rect.y * canvas.height,
        width: overlay.rect.width * canvas.width,
        height: overlay.rect.height * canvas.height,
      };
      if (overlay.displayMode === "none") continue; // audio-only narration -- nothing drawn
      if (overlay.displayMode === "karaoke") {
        drawKaraokeCaption(ctx, rectPx, overlay.wordTimings, findActiveWordIndex(overlay, elapsedSeconds), overlay.templateId);
        continue;
      }
      const renderer = getTextTemplateRenderer(overlay.templateId);
      if (!renderer) continue;
      renderer({
        ctx,
        text: overlay.text,
        rectPx,
        progress: computeProgress(overlay.startTimeSeconds, ttsOverlayEndTimeSeconds(overlay), elapsedSeconds),
      });
    }

    // Automatic branding -- always drawn last, on top of every other
    // overlay/caption, so nothing else on the timeline can cover it. Not
    // user-authored (see brandWatermark.ts's own module comment); a no-op
    // outside the final BRAND_WATERMARK_DURATION_SECONDS of the sequence.
    drawBrandWatermark(ctx, canvas.width, canvas.height, elapsedSeconds, durationRef.current);
  }

  function tick() {
    const audioContext = audioContextRef.current;
    if (!audioContext) return;

    const elapsed = pausedAtSecondsRef.current + (audioContext.currentTime - playStartedAtCtxTimeRef.current);

    // Crossed into a cut section -- jump the audio source itself forward
    // to just past it (not just what's drawn), so audio and video stay in
    // sync through the cut rather than the picture skipping while the
    // audio keeps playing the deleted stretch underneath.
    const skippedElapsed = skipTrimmedRanges(getEffectiveSkipRanges(), elapsed);
    if (skippedElapsed !== elapsed) {
      stopPlaybackLoop();
      if (skippedElapsed >= durationRef.current) {
        if (isLoopingRef.current) {
          resumePlaybackFrom(0);
          return;
        }
        drawFrameAt(durationRef.current);
        onTimeUpdate?.(durationRef.current);
        pausedAtSecondsRef.current = 0;
        setIsPlaying(false);
        return;
      }
      resumePlaybackFrom(skippedElapsed);
      return;
    }

    if (elapsed >= durationRef.current) {
      if (isLoopingRef.current) {
        stopPlaybackLoop();
        resumePlaybackFrom(0);
        return;
      }
      drawFrameAt(durationRef.current);
      onTimeUpdate?.(durationRef.current);
      stopPlaybackLoop();
      pausedAtSecondsRef.current = 0;
      setIsPlaying(false);
      return;
    }
    drawFrameAt(elapsed);
    onTimeUpdate?.(elapsed);
    animationFrameIdRef.current = requestAnimationFrame(tick);
  }

  /** Starts (or resumes) playback from `offsetSeconds` -- shared by the
   * Play button and seekTo-while-playing, since both boil down to "spin
   * up a fresh AudioBufferSourceNode at this offset and restart the RAF
   * loop" (a source node can't be paused/resumed in place, only stopped).
   * Skips the offset itself forward past a cut, in case Play is pressed
   * (or a seek lands) with the clock sitting inside a trimmed range. */
  function resumePlaybackFrom(offsetSeconds: number) {
    const audioBuffer = audioBufferRef.current;
    if (!audioBuffer) return;
    const audioContext = ensureAudioContext();
    const masterGainNode = masterGainNodeRef.current!;
    // The context is first created back in the clip-loading effect (not a
    // user gesture), so browsers start it "suspended" -- this Play click is
    // the actual user gesture, so it's the one place that can legally
    // resume it. Without this, every source below connects fine but never
    // makes sound: state stays "suspended" forever since nothing else ever
    // calls resume().
    if (audioContext.state === "suspended") void audioContext.resume();

    const adjustedOffsetSeconds = Math.min(skipTrimmedRanges(getEffectiveSkipRanges(), offsetSeconds), durationRef.current);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    // Routed through a gain node (rather than straight to destination) so
    // it can be "ducked" for any video-overlay or TTS-narration window that
    // wants some of its own audio mixed in -- see computeAudioMixBreakpoints/
    // sampleAudioMixAt. A fresh node every resume, same as the source
    // itself; nothing to clean up beyond what stopping/discarding the
    // source already does.
    const mainGainNode = audioContext.createGain();
    source.connect(mainGainNode).connect(masterGainNode);
    source.start(0, adjustedOffsetSeconds);
    sourceNodeRef.current = source;
    playStartedAtCtxTimeRef.current = audioContext.currentTime;
    pausedAtSecondsRef.current = adjustedOffsetSeconds;

    // The full breakpoint list for this resume's whole remaining playback --
    // shared below by the main track's own ramp AND by every active
    // overlay-audio/TTS-audio source's own gain automation (each multiplies
    // its OWN nominal level by breakpoint.duckScale at the same instants),
    // so all three tracks' ducking can never drift apart mid-window.
    const audioMixBreakpoints = computeAudioMixBreakpoints(videoOverlays, ttsOverlays, durationRef.current);

    // Covers the case where adjustedOffsetSeconds itself lands mid-window
    // (no breakpoint exists exactly there since breakpoints only mark
    // window START/END) -- sets the correct starting gain immediately
    // rather than waiting for whatever breakpoint comes next. Also seeds
    // the ramp loop below, so its first transition starts from what's
    // actually already playing rather than an assumed 1.
    const initialMix = sampleAudioMixAt(videoOverlays, ttsOverlays, adjustedOffsetSeconds);
    mainGainNode.gain.setValueAtTime(initialMix.mainGain * mainAudioVolume, audioContext.currentTime);

    // Short ramps rather than hard setValueAtTime steps -- a hard step is an
    // audible click/pop. The standard Web Audio pattern for "a step
    // function with brief transitions": anchor the ramp's start value (a
    // no-op numerically, but required so the ramp doesn't creep from
    // whatever far-away event preceded it) then ramp to the new value.
    // Every breakpoint.mainGain (a 0..1 ducking fraction against a ceiling
    // of 1) is scaled by mainAudioVolume so ducking still happens relative
    // to wherever the user has set the overall level, not against a fixed 1.
    let previousGain = initialMix.mainGain * mainAudioVolume;
    for (const breakpoint of audioMixBreakpoints) {
      if (breakpoint.timeSeconds < adjustedOffsetSeconds) continue; // already in the past relative to this resume
      const rampStartCtxTime = audioContext.currentTime + (breakpoint.timeSeconds - adjustedOffsetSeconds);
      const targetGain = breakpoint.mainGain * mainAudioVolume;
      mainGainNode.gain.setValueAtTime(previousGain, rampStartCtxTime);
      mainGainNode.gain.linearRampToValueAtTime(targetGain, rampStartCtxTime + AUDIO_TRANSITION_RAMP_SECONDS);
      previousGain = targetGain;
    }

    // Schedules `gainNode`'s automation across [windowStartSeconds,
    // windowEndSeconds) as: a fade (from silence, or an immediate hold when
    // resuming mid-window and `fadeInFromSilence` is false) to
    // `nominalGain` scaled by whatever `duckScale` applies at the window's
    // own start, then a plateau at each audioMixBreakpoints crossing WITHIN
    // the window (so this clip's own audio actually dips in step with the
    // main track's own dip during an overlapping TTS/video-overlay window,
    // not just independently of it), finishing with a fade-out to 0 at the
    // window's own end. Shared by the video-overlay-audio and
    // TTS-narration-audio blocks below so their ducking math can't diverge
    // from each other or from the main-track ramp above (same
    // audioMixBreakpoints list, same AUDIO_TRANSITION_RAMP_SECONDS ramp).
    function scheduleDuckedGain(
      gainNode: GainNode,
      nominalGain: number,
      windowStartSeconds: number,
      windowEndSeconds: number,
      startCtxTime: number,
      fadeInFromSilence: boolean
    ) {
      const remainingDurationSeconds = windowEndSeconds - windowStartSeconds;
      const fadeOutStartCtxTime = Math.max(
        startCtxTime + AUDIO_TRANSITION_RAMP_SECONDS,
        startCtxTime + remainingDurationSeconds - AUDIO_TRANSITION_RAMP_SECONDS
      );
      function duckScaleAt(timeSeconds: number): number {
        let scale = 1;
        for (const bp of audioMixBreakpoints) {
          if (bp.timeSeconds > timeSeconds) break;
          scale = bp.duckScale;
        }
        return scale;
      }

      let previousGain: number;
      let previousCtxTime: number;
      if (fadeInFromSilence) {
        gainNode.gain.setValueAtTime(0, startCtxTime);
        previousCtxTime = startCtxTime + AUDIO_TRANSITION_RAMP_SECONDS;
        previousGain = nominalGain * duckScaleAt(windowStartSeconds);
        gainNode.gain.linearRampToValueAtTime(previousGain, previousCtxTime);
      } else {
        previousGain = nominalGain * duckScaleAt(windowStartSeconds);
        gainNode.gain.setValueAtTime(previousGain, startCtxTime);
        previousCtxTime = startCtxTime;
      }
      for (const bp of audioMixBreakpoints) {
        if (bp.timeSeconds <= windowStartSeconds || bp.timeSeconds >= windowEndSeconds) continue;
        const rampCtxTime = startCtxTime + (bp.timeSeconds - windowStartSeconds);
        if (rampCtxTime <= previousCtxTime) continue;
        const target = nominalGain * bp.duckScale;
        gainNode.gain.setValueAtTime(previousGain, rampCtxTime);
        gainNode.gain.linearRampToValueAtTime(target, rampCtxTime + AUDIO_TRANSITION_RAMP_SECONDS);
        previousGain = target;
        previousCtxTime = rampCtxTime + AUDIO_TRANSITION_RAMP_SECONDS;
      }
      gainNode.gain.setValueAtTime(previousGain, Math.max(fadeOutStartCtxTime, previousCtxTime));
      gainNode.gain.linearRampToValueAtTime(0, startCtxTime + remainingDurationSeconds);
    }

    // One AudioBufferSourceNode per overlay that wants some of its own
    // audio (audioBalance > 0) and has actually finished decoding by now --
    // all scheduled up front here, same "schedule everything ahead of
    // time" idiom the single background-music loop below already uses,
    // just per-overlay instead of one continuous loop. `loop = true`
    // unconditionally is always safe (a no-op unless the window genuinely
    // outlasts one play-through -- see VideoOverlayTrack.tsx's own
    // edge-drag comment on why a window CAN now exceed its source's length).
    overlayAudioSourceNodesRef.current = [];
    for (const overlay of videoOverlays) {
      if (overlay.audioBalance <= 0) continue;
      if (overlay.endTimeSeconds <= adjustedOffsetSeconds) continue; // this window is entirely in the past
      const overlayBuffer = videoOverlayAudioBuffersByAssetIdRef.current[overlay.assetId];
      if (!overlayBuffer || overlayBuffer.duration <= 0) continue;

      const windowStartSeconds = Math.max(overlay.startTimeSeconds, adjustedOffsetSeconds);
      const elapsedIntoWindowSeconds = windowStartSeconds - overlay.startTimeSeconds;
      const remainingDurationSeconds = overlay.endTimeSeconds - windowStartSeconds;
      const startCtxTime = audioContext.currentTime + (windowStartSeconds - adjustedOffsetSeconds);

      const overlaySource = audioContext.createBufferSource();
      overlaySource.buffer = overlayBuffer;
      overlaySource.loop = true;
      const overlayGainNode = audioContext.createGain();
      // Ducked against any TTS narration (and, unusually, any other
      // overlapping overlay) sharing this window -- see scheduleDuckedGain
      // above and sampleAudioMixAt's own doc comment for the mixer spec.
      scheduleDuckedGain(overlayGainNode, overlay.audioBalance, windowStartSeconds, overlay.endTimeSeconds, startCtxTime, true);
      overlaySource.connect(overlayGainNode).connect(masterGainNode);
      overlaySource.start(startCtxTime, elapsedIntoWindowSeconds % overlayBuffer.duration, remainingDurationSeconds);
      overlayAudioSourceNodesRef.current.push(overlaySource);
    }

    // One AudioBufferSourceNode per TTS narration overlay whose audio has
    // finished decoding and whose window hasn't fully passed yet -- same
    // per-item, scheduled-at-its-own-time-offset idiom as the video-overlay
    // audio block above (NOT the background-music model: narration plays
    // once at its own instant, it never loops). Ducked against any active
    // video-overlay audio sharing this window via the same
    // scheduleDuckedGain/audioMixBreakpoints the main track and the
    // video-overlay-audio block above both use -- see sampleAudioMixAt's
    // own doc comment for the mixer spec (background music is NOT part of
    // this mix; it plays unaffected by narration, a deliberate scope
    // decision, not an oversight).
    ttsAudioSourceNodesRef.current = [];
    for (const overlay of ttsOverlays) {
      const overlayEndSeconds = ttsOverlayEndTimeSeconds(overlay);
      if (overlayEndSeconds <= adjustedOffsetSeconds) continue; // this window is entirely in the past
      const ttsBuffer = ttsAudioBuffersByAssetIdRef.current[overlay.assetId];
      if (!ttsBuffer || ttsBuffer.duration <= 0) continue;

      const windowStartSeconds = Math.max(overlay.startTimeSeconds, adjustedOffsetSeconds);
      const elapsedIntoWindowSeconds = windowStartSeconds - overlay.startTimeSeconds;
      const remainingDurationSeconds = overlayEndSeconds - windowStartSeconds;
      if (remainingDurationSeconds <= 0) continue;
      const startCtxTime = audioContext.currentTime + (windowStartSeconds - adjustedOffsetSeconds);

      const ttsSource = audioContext.createBufferSource();
      ttsSource.buffer = ttsBuffer;
      const ttsGainNode = audioContext.createGain();
      const nominalGain = Math.min(Math.max(overlay.volume, 0), 1);
      // Skips the fade-IN when resuming from partway through the narration
      // (nothing to fade from silence into, it's already playing) -- same
      // reasoning as before this mix became duck-aware.
      scheduleDuckedGain(ttsGainNode, nominalGain, windowStartSeconds, overlayEndSeconds, startCtxTime, elapsedIntoWindowSeconds <= 0);
      ttsSource.connect(ttsGainNode).connect(masterGainNode);
      ttsSource.start(startCtxTime, elapsedIntoWindowSeconds, remainingDurationSeconds);
      ttsAudioSourceNodesRef.current.push(ttsSource);
    }

    // The audio side of every cut-transition boundary reachable from this
    // resume: a short-lived source node previews the incoming clip's own
    // upcoming audio (read from the SAME concatenated `audioBuffer`, at ITS
    // OWN real, unshifted buffer offset -- see cutTransitionById/
    // getEffectiveSkipRanges' own module comment) with its gain ramping in,
    // while `mainGainNode` (still playing the outgoing clip) dips to 0 across
    // the same window then snaps back right after -- once the boundary is
    // crossed, tick()'s own skip logic restarts the main source past the
    // now-redundant preview stretch, so the main track alone carries the
    // incoming clip's REAL audio from then on. KNOWN LIMITATION: only
    // windows entirely AHEAD of this resume point are scheduled -- a seek
    // that lands mid-transition falls back to a plain volume jump for that
    // one boundary rather than a partial crossfade.
    cutTransitionAudioSourceNodesRef.current = [];
    for (let i = 1; i < loadedClipsRef.current.length; i++) {
      const clip = loadedClipsRef.current[i];
      const cutTransitionInId = clip.id ? cutTransitionById.get(clip.id) ?? null : null;
      if (!cutTransitionInId) continue;
      const overlapSeconds = resolveCutTransitionOverlapSeconds(cutTransitionInId, true, loadedClipsRef.current[i - 1].durationSeconds, clip.durationSeconds);
      if (overlapSeconds <= 0) continue;
      const windowStartSeconds = clip.startTimeSeconds - overlapSeconds;
      if (windowStartSeconds < adjustedOffsetSeconds) continue; // already in the past, or mid-window -- see KNOWN LIMITATION above
      const startCtxTime = audioContext.currentTime + (windowStartSeconds - adjustedOffsetSeconds);
      const ambientGain = sampleAudioMixAt(videoOverlays, ttsOverlays, windowStartSeconds).mainGain * mainAudioVolume;

      const previewSource = audioContext.createBufferSource();
      previewSource.buffer = audioBuffer;
      const previewGainNode = audioContext.createGain();
      previewGainNode.gain.setValueAtTime(0, startCtxTime);
      previewGainNode.gain.linearRampToValueAtTime(ambientGain, startCtxTime + overlapSeconds);
      previewSource.connect(previewGainNode).connect(masterGainNode);
      previewSource.start(startCtxTime, clip.startTimeSeconds, overlapSeconds);
      cutTransitionAudioSourceNodesRef.current.push(previewSource);

      // The outgoing (main-track) side of the same crossfade -- dips to 0
      // exactly as the preview above finishes ramping in, then snaps back
      // to the ambient level right after (the main source itself resumes
      // playing the incoming clip's own real audio at that point, once
      // tick() performs its own skip past the redundant preview stretch).
      mainGainNode.gain.setValueAtTime(ambientGain, startCtxTime);
      mainGainNode.gain.linearRampToValueAtTime(0, startCtxTime + overlapSeconds);
      mainGainNode.gain.setValueAtTime(0, startCtxTime + overlapSeconds);
      mainGainNode.gain.linearRampToValueAtTime(ambientGain, startCtxTime + overlapSeconds + AUDIO_TRANSITION_RAMP_SECONDS);
    }

    // One AudioBufferSourceNode per music clip whose window hasn't fully
    // passed yet -- same "schedule everything ahead of time" idiom as the
    // video-overlay-audio block above, all through one shared gain node
    // (background music has never participated in ducking, so no per-clip
    // gain automation is needed). `loop`/`loopStart`/`loopEnd` let a clip
    // stretched past one play-through of its own source wrap back to its
    // own trim-in point (sourceStartSeconds) rather than 0 -- see
    // video_math.ts's MusicClip doc comment on why that's deliberately
    // allowed, unlike VideoOverlayClip's own edge-drag today.
    const musicGainNode = audioContext.createGain();
    musicGainNode.gain.value = backgroundVolume;
    musicGainNode.connect(masterGainNode);
    musicSourceNodesRef.current = [];
    for (const clip of musicClips) {
      if (clip.endTimeSeconds <= adjustedOffsetSeconds) continue; // this window is entirely in the past
      const buffer = musicAudioBuffersByAssetIdRef.current[clip.assetId];
      if (!buffer || buffer.duration <= 0) continue;

      const windowStartSeconds = Math.max(clip.startTimeSeconds, adjustedOffsetSeconds);
      const elapsedIntoWindowSeconds = windowStartSeconds - clip.startTimeSeconds;
      const remainingDurationSeconds = clip.endTimeSeconds - windowStartSeconds;
      const startCtxTime = audioContext.currentTime + (windowStartSeconds - adjustedOffsetSeconds);
      const playableSourceSeconds = Math.max(buffer.duration - clip.sourceStartSeconds, 0.0001);
      const bufferOffsetSeconds = clip.sourceStartSeconds + (elapsedIntoWindowSeconds % playableSourceSeconds);

      const musicSource = audioContext.createBufferSource();
      musicSource.buffer = buffer;
      musicSource.loop = true;
      musicSource.loopStart = clip.sourceStartSeconds;
      musicSource.loopEnd = buffer.duration;
      musicSource.connect(musicGainNode);
      musicSource.start(startCtxTime, bufferOffsetSeconds, remainingDurationSeconds);
      musicSourceNodesRef.current.push(musicSource);
    }

    setIsPlaying(true);
    animationFrameIdRef.current = requestAnimationFrame(tick);
  }

  function pausePlayback() {
    if (!isPlaying) return;
    const audioContext = audioContextRef.current;
    if (audioContext) {
      pausedAtSecondsRef.current += audioContext.currentTime - playStartedAtCtxTimeRef.current;
    }
    stopPlaybackLoop();
    setIsPlaying(false);
    onTimeUpdate?.(pausedAtSecondsRef.current);
  }

  function handlePlayPause() {
    if (!isReady) return;

    if (isPlaying) {
      pausePlayback();
      return;
    }

    resumePlaybackFrom(pausedAtSecondsRef.current);
  }

  function handleToggleLoop() {
    const next = !isLooping;
    setIsLooping(next);
    isLoopingRef.current = next;
  }

  function handleToggleMute() {
    const next = !isMuted;
    setIsMuted(next);
    isMutedRef.current = next;
    // Takes effect immediately even mid-playback -- a plain value assignment
    // (not scheduled via setValueAtTime/ramp) is fine here since it's a
    // discrete user click, not something that needs to land at a precise
    // audio-clock instant like the ducking automation elsewhere in this file.
    if (masterGainNodeRef.current) masterGainNodeRef.current.gain.value = next ? 0 : 1;
  }

  // Tracks isFullscreen off the browser's own state rather than the click
  // handler alone -- also fires on Escape / the browser's native "exit
  // fullscreen" affordance, which don't go through handleToggleFullscreen.
  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === playerRootRef.current);
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  function handleToggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void playerRootRef.current?.requestFullscreen();
    }
  }

  useImperativeHandle(ref, () => ({
    seekTo(seconds: number) {
      if (!isReady) return;
      const clamped = Math.min(Math.max(seconds, 0), durationRef.current);
      if (isPlaying) {
        stopPlaybackLoop();
        resumePlaybackFrom(clamped);
      } else {
        // resumePlaybackFrom already skips past a cut internally -- this
        // branch doesn't call it, so it needs the same skip itself.
        const adjusted = Math.min(skipTrimmedRanges(getEffectiveSkipRanges(), clamped), durationRef.current);
        pausedAtSecondsRef.current = adjusted;
        drawFrameAt(adjusted);
        onTimeUpdate?.(adjusted);
      }
    },
    captureFrame() {
      if (!isReady || !canvasRef.current) return Promise.resolve(null);
      const canvas = canvasRef.current;
      return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92));
    },
    pause: pausePlayback,
  }));

  // Extracts every clip's preview frames + decodes every clip's audio,
  // sequentially (bounds peak memory -- see this file's module comment),
  // then concatenates the decoded audio into one buffer so playback still
  // uses a single AudioBufferSourceNode. A clip that fails to load is
  // skipped and excluded from loadedClipsRef -- the rest of the sequence
  // still plays. Keyed on a joined clip id/url string, not the `clips`
  // array reference, so an unrelated re-render (e.g. a crop edit) doesn't
  // re-trigger a full re-extraction.
  const clipsKey = clips.map((clip) => `${clip.id}:${clip.url}:${clip.kind === "image" ? clip.durationSeconds : ""}`).join(",");
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadingStage("Loading video…");
    setIsReady(false);
    setError(null);
    setPartialLoadWarning(null);
    setIsPlaying(false);
    clipImagesRef.current = [];
    frameRatesRef.current = [];
    clipMattesRef.current = [];
    clipCamera3DSubjectCutoutsRef.current = [];
    clipFaceGeometriesRef.current = [];
    loadedClipsRef.current = [];
    audioBufferRef.current = null;
    pausedAtSecondsRef.current = 0;
    onTimeUpdate?.(0);

    async function load() {
      if (clips.length === 0) return;
      const audioContext = ensureAudioContext();

      type LoadedClipMeta = { id: string; assetId: string; url: string; durationSeconds: number; kind: "video" | "image" | "text" };
      type ClipLoadResult =
        | {
            ok: true;
            images: (HTMLImageElement | ImageBitmap)[];
            frameRate: number;
            audioBuffer: AudioBuffer;
            meta: LoadedClipMeta;
            mattes: ImageBitmap[] | null;
            camera3DSubjectCutout: HTMLImageElement | ImageBitmap | null;
            faceGeometry: FaceGeometry | null;
          }
        | { ok: false; message: string };

      // Fraction (0..1) each clip has progressed -- driven by
      // extractPreviewFrames's own onProgress for video clips, jumping
      // straight to 1 on completion for image clips (near-instant, no
      // meaningful intermediate state). Clips load PIPELINED, up to
      // CLIP_LOAD_CONCURRENCY at once, rather than one Promise.all over
      // every clip -- full parallelism would multiply peak memory by clip
      // count (decoding pulls a whole file into memory with no streaming,
      // see this file's module comment); capping at 2 bounds that to
      // roughly "2 clips' worth" while still overlapping one clip's
      // network/decode latency with the next instead of paying it once per
      // clip in series.
      const clipProgress: number[] = new Array(clips.length).fill(0);
      function reportProgress() {
        if (cancelled) return;
        const overall = clipProgress.reduce((sum, fraction) => sum + fraction, 0) / clips.length;
        setLoadingStage(`${clips.length > 1 ? "Loading video" : "Loading frames & audio"} — ${Math.round(overall * 100)}%`);
      }

      async function loadClipAt(index: number): Promise<ClipLoadResult> {
        const clip = clips[index];
        try {
          if (clip.kind === "text") {
            // A text slide has no file to decode at all -- its content is
            // drawn fresh every frame by drawFrameAt's own early-return
            // branch below (textSlideRenderer.ts's drawTextSlide), never
            // from a pre-extracted frame array. `images` still needs ONE
            // non-empty entry so the generic per-clip bookkeeping below
            // (audio-buffer concatenation, etc.) has something to hold --
            // it's never actually drawn. Kept off `referenceFrameSizeRef`
            // (see the firstImage lookup below, which skips text clips) so
            // a 1x1 placeholder can never corrupt every other clip's own
            // crop reprojection.
            const duration = clip.durationSeconds;
            const placeholderImage = await createImageBitmap(new ImageData(1, 1));
            const silentAudioBuffer = audioContext.createBuffer(1, Math.max(1, Math.round(duration * audioContext.sampleRate)), audioContext.sampleRate);
            clipProgress[index] = 1;
            reportProgress();
            return {
              ok: true,
              images: [placeholderImage],
              frameRate: 1,
              audioBuffer: silentAudioBuffer,
              meta: { id: clip.id, assetId: clip.assetId, url: clip.url, durationSeconds: duration, kind: "text" },
              mattes: null,
              camera3DSubjectCutout: null,
              faceGeometry: null,
            };
          }
          if (clip.kind === "image") {
            // An image clip is "a video with exactly one frame, held for
            // its authored duration, with silent audio" -- no file to
            // probe/decode. frameIndexAtTime already clamps to
            // frameCount - 1, so a single-frame array naturally holds that
            // one frame for the whole clip with no other changes needed.
            const duration = clip.durationSeconds;

            // AI background removal for a Ken Burns cutaway -- unlike the
            // video path (a separate per-frame matte, see below), the
            // single "frame" here is REPLACED outright by an already-
            // transparent cutout, since a still image's own alpha channel
            // needs no separate mask element at all (see
            // compileCreatomateTimeline.ts's buildBackgroundRemovedImageSegment
            // and backgroundSegmentation.ts's own module comment). The real
            // rembg cutout once ready, else an instant approximate one --
            // same two-stage staging as the video path, just producing a
            // full RGBA image instead of a bare alpha mask.
            let image: HTMLImageElement | ImageBitmap;
            if (clip.backgroundRemoval?.mode === "chromaKey") {
              // No matte to wait on -- keyed out live against the original
              // photo, same as chromaKeyFramesToAlphaMasks' video-overlay
              // counterpart (see chromaKey.ts's own module comment).
              try {
                image = await chromaKeyImageToBitmap(await loadImage(clip.url), clip.backgroundRemoval.chromaKeyColor ?? DEFAULT_CHROMA_KEY_COLOR);
              } catch (err) {
                console.error("chroma-key cutout failed for clip=%s", clip.id, err);
                image = await loadImage(clip.url);
              }
            } else if (clip.backgroundRemoval?.enabled) {
              const matteUrl = clip.backgroundRemoval.matteAssetId ? assetUrlById[clip.backgroundRemoval.matteAssetId] : undefined;
              try {
                image = matteUrl ? await loadImage(matteUrl) : await segmentImageApproximate(await loadImage(clip.url));
              } catch (err) {
                console.error("background-removal cutout failed for clip=%s", clip.id, err);
                image = await loadImage(clip.url);
              }
            } else {
              image = await loadImage(clip.url);
            }

            // "Make it 3D" foreground/background parallax -- an automatic
            // subject cutout so the dolly/pan gets real depth (the subject
            // parallaxes against its own background) instead of just moving
            // one flat plane. Skipped when backgroundRemoval is ALSO enabled
            // -- that combination keeps its own existing (flat cutout over a
            // new backdrop) treatment, under which `image` above is already
            // the cutout and camera3D never runs at all (see drawFrameAt's
            // own branch priority) -- so there's no original photo left
            // here to build a parallax background from in that case anyway.
            // Also needed (independent of camera3D) whenever the "halo"
            // faceEffect is picked -- its own occlusion trick (camera3D.ts's
            // HALO_DEPTH_FRACTION) depends on this same cutout.
            let camera3DSubjectCutout: HTMLImageElement | ImageBitmap | null = null;
            if ((clip.camera3D || clip.faceEffect === "halo") && !clip.backgroundRemoval?.enabled) {
              try {
                camera3DSubjectCutout = await segmentImageApproximate(image);
              } catch (err) {
                console.error("3D subject cutout failed for clip=%s", clip.id, err);
              }
            }

            // Face detection (faceLandmarks.ts) for the "Torus above head"/
            // "Halo behind head" pick -- same one-shot-per-asset shape, and
            // same backgroundRemoval scoping, as camera3DSubjectCutout above
            // (see clipFaceEffectById's own comment for why that combination
            // isn't supported).
            let faceGeometry: FaceGeometry | null = null;
            if (clip.faceEffect && !clip.backgroundRemoval?.enabled) {
              try {
                faceGeometry = await detectFaceGeometry(image);
              } catch (err) {
                console.error("Face detection failed for clip=%s", clip.id, err);
              }
            }

            const silentAudioBuffer = audioContext.createBuffer(1, Math.max(1, Math.round(duration * audioContext.sampleRate)), audioContext.sampleRate);
            clipProgress[index] = 1;
            reportProgress();
            return {
              ok: true,
              images: [image],
              frameRate: 1,
              audioBuffer: silentAudioBuffer,
              meta: { id: clip.id, assetId: clip.assetId, url: clip.url, durationSeconds: duration, kind: "image" },
              mattes: null,
              camera3DSubjectCutout,
              faceGeometry,
            };
          }

          const duration = await getVideoDuration(clip.url);
          const frameRate = pickPreviewFrameRate(duration, navigator.hardwareConcurrency || 4);
          const [images, audioBuffer] = await Promise.all([
            extractPreviewFrames(clip.url, frameRate, (framesSoFar, totalFrames) => {
              clipProgress[index] = totalFrames > 0 ? framesSoFar / totalFrames : 1;
              reportProgress();
            }),
            decodeAudioBuffer(clip.url),
          ]);
          clipProgress[index] = 1;
          reportProgress();

          // AI background removal -- real matte (extracted at the SAME
          // frameRate, so it lines up frame-for-frame with `images`) once
          // ready, else an instant approximate cutout straight off the
          // frames just extracted above. Failures here don't fail the clip
          // itself -- backgroundSegmentation.ts's own helpers already fall
          // back to "fully opaque" (draws as a normal, unmasked clip) on
          // error, same "a clip that fails to load is skipped, everything
          // else plays" spirit this file's module comment already states
          // for the clip-load loop as a whole.
          let mattes: ImageBitmap[] | null = null;
          if (clip.kind === "video" && clip.backgroundRemoval?.mode === "chromaKey") {
            try {
              mattes = await chromaKeyFramesToAlphaMasks(images, clip.backgroundRemoval.chromaKeyColor ?? DEFAULT_CHROMA_KEY_COLOR);
            } catch (err) {
              console.error("chroma-key mask extraction failed for clip=%s", clip.id, err);
            }
          } else if (clip.kind === "video" && clip.backgroundRemoval?.enabled) {
            const matteUrl = clip.backgroundRemoval.matteAssetId ? assetUrlById[clip.backgroundRemoval.matteAssetId] : undefined;
            try {
              mattes = matteUrl
                ? await lumaFramesToAlphaMasks(await extractPreviewFrames(matteUrl, frameRate))
                : await segmentClipFramesApproximate(images);
            } catch (err) {
              console.error("background-removal mask extraction failed for clip=%s", clip.id, err);
            }
          }

          return {
            ok: true,
            images,
            frameRate,
            audioBuffer,
            meta: { id: clip.id, assetId: clip.assetId, url: clip.url, durationSeconds: duration, kind: "video" },
            mattes,
            // "Make it 3D" parallax (see the image branch above) is scoped
            // to still-image Ken Burns cutaways only -- a video clip has no
            // single frame to segment once for its whole duration.
            camera3DSubjectCutout: null,
            faceGeometry: null,
          };
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : "Failed to load this clip" };
        }
      }

      const results: ClipLoadResult[] = new Array(clips.length);
      const CLIP_LOAD_CONCURRENCY = 2;
      let nextIndex = 0;
      async function worker() {
        while (!cancelled) {
          const index = nextIndex++;
          if (index >= clips.length) return;
          results[index] = await loadClipAt(index);
        }
      }
      await Promise.all(Array.from({ length: Math.min(CLIP_LOAD_CONCURRENCY, clips.length) }, () => worker()));
      if (cancelled) return;

      const loadedImages: (HTMLImageElement | ImageBitmap)[][] = [];
      const loadedFrameRates: number[] = [];
      const loadedAudioBuffers: AudioBuffer[] = [];
      const loadedClipMeta: LoadedClipMeta[] = [];
      const loadedMattes: (ImageBitmap[] | null)[] = [];
      const loadedCamera3DSubjectCutouts: (HTMLImageElement | ImageBitmap | null)[] = [];
      const loadedFaceGeometries: (FaceGeometry | null)[] = [];
      let failureCount = 0;
      let lastFailureMessage = "";
      for (const result of results) {
        if (result.ok) {
          loadedImages.push(result.images);
          loadedFrameRates.push(result.frameRate);
          loadedAudioBuffers.push(result.audioBuffer);
          loadedClipMeta.push(result.meta);
          loadedMattes.push(result.mattes);
          loadedCamera3DSubjectCutouts.push(result.camera3DSubjectCutout);
          loadedFaceGeometries.push(result.faceGeometry);
        } else {
          failureCount += 1;
          lastFailureMessage = result.message;
        }
      }

      if (loadedClipMeta.length === 0) {
        throw new Error(lastFailureMessage || "Failed to load this video for playback");
      }

      clipImagesRef.current = loadedImages;
      frameRatesRef.current = loadedFrameRates;
      clipMattesRef.current = loadedMattes;
      clipCamera3DSubjectCutoutsRef.current = loadedCamera3DSubjectCutouts;
      clipFaceGeometriesRef.current = loadedFaceGeometries;
      loadedClipsRef.current = buildSequenceClipInfos(loadedClipMeta);
      durationRef.current = totalSequenceDuration(loadedClipsRef.current);
      audioBufferRef.current = concatenateAudioBuffers(audioContext, loadedAudioBuffers);

      // Skips a "text" clip's own 1x1 placeholder bitmap -- see loadClipAt's
      // own text branch above for why it must never be trusted for sizing.
      // If the WHOLE sequence is text slides, no real frame exists to seed
      // this from; referenceFrameSizeRef simply keeps whatever it already
      // had (its own initial default covers a fresh player).
      const firstNonTextIndex = loadedClipMeta.findIndex((meta) => meta.kind !== "text");
      const firstImage = firstNonTextIndex !== -1 ? loadedImages[firstNonTextIndex]?.[0] : undefined;
      if (firstImage) {
        referenceFrameSizeRef.current = { width: firstImage.width, height: firstImage.height };
        onFrameDimensions?.({ width: firstImage.width, height: firstImage.height });
      }

      if (failureCount > 0) {
        setPartialLoadWarning(
          `${failureCount} clip${failureCount > 1 ? "s" : ""} in this sequence failed to load and ${failureCount > 1 ? "were" : "was"} skipped (${lastFailureMessage}).`
        );
      }

      setIsReady(true);
      drawFrameAt(0);
    }

    load()
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load this video for playback");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
      stopPlaybackLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on clipsKey (a joined id/url string), not the clips array reference; onTimeUpdate/onFrameDimensions are stable setters from the parent
  }, [clipsKey]);

  // Redraws the current (static) frame whenever the crop/zoom/live-drag
  // state changes while paused -- e.g. adjusting the active tile's crop on
  // FrameStrip should update what the player shows immediately, not only
  // once playback next passes through that instant.
  useEffect(() => {
    if (isReady && !isPlaying) drawFrameAt(pausedAtSecondsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drawFrameAt is freshly defined every render and always closes over the latest crop/zoom props
  }, [
    baseCropRect,
    zoomEffects,
    liveCropRectOverride,
    flipHorizontalToggles,
    flipVerticalToggles,
    trimRanges,
    overlayImages,
    textOverlays,
    ttsOverlays,
    videoOverlays,
    isReady,
    isPlaying,
  ]);

  // Loads each currently-referenced overlay image once (cached in
  // overlayImagesRef by assetId) and redraws the current frame once any of
  // them finish -- covers both "an overlay was just added, its image
  // hasn't loaded yet" and "the asset list refreshed with a fresh
  // presigned URL for one already loaded" (re-fetches, since the object
  // itself hasn't changed this is cheap and just replaces the same
  // pixels). A missing/failed image is skipped in drawFrameAt, not
  // surfaced as a page error -- one broken overlay thumbnail shouldn't
  // block playback of everything else.
  useEffect(() => {
    let cancelled = false;
    const toLoad = overlayImages
      .map((overlay) => ({ assetId: overlay.assetId, url: assetUrlById[overlay.assetId] }))
      .filter(({ url }) => url);
    // Which loaded assets actually need face detection -- any overlay clip
    // reusing that asset with a faceEffect picked.
    const faceEffectAssetIds = new Set(overlayImages.filter((overlay) => overlay.faceEffect).map((overlay) => overlay.assetId));

    Promise.all(
      toLoad.map(({ assetId, url }) =>
        loadImage(url)
          .then((img) => ({ assetId, img }))
          .catch(() => null)
      )
    ).then(async (loaded) => {
      if (cancelled) return;
      let didLoadAny = false;
      for (const entry of loaded) {
        if (!entry) continue;
        overlayImagesRef.current[entry.assetId] = entry.img;
        didLoadAny = true;
        // One-shot per unique asset -- skipped once already computed (or
        // already attempted, even if it came back null/no-face).
        if (faceEffectAssetIds.has(entry.assetId) && !(entry.assetId in overlayFaceGeometriesRef.current)) {
          try {
            overlayFaceGeometriesRef.current[entry.assetId] = await detectFaceGeometry(entry.img);
          } catch (err) {
            console.error("Face detection failed for overlay asset=%s", entry.assetId, err);
            overlayFaceGeometriesRef.current[entry.assetId] = null;
          }
        }
      }
      if (cancelled) return;
      if (didLoadAny && isReady && !isPlaying) drawFrameAt(pausedAtSecondsRef.current);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drawFrameAt is freshly defined every render and always closes over the latest crop/zoom props
  }, [overlayImages, assetUrlById, isReady, isPlaying]);

  // Loads each currently-referenced Text Slide's own optional background/
  // layout image once (cached in textSlideImagesRef by assetId) and
  // redraws once any of them finish -- same shape as the overlay-image
  // loading effect immediately above, just sourced from `clips` (the base
  // sequence) rather than the `overlayImages` prop.
  useEffect(() => {
    let cancelled = false;
    const toLoad = clips
      .filter((clip): clip is TextSlideEntry & { url: string } => clip.kind === "text" && Boolean(clip.assetId))
      .map((clip) => ({ assetId: clip.assetId, url: assetUrlById[clip.assetId] }))
      .filter(({ url }) => url);

    Promise.all(
      toLoad.map(({ assetId, url }) =>
        loadImage(url)
          .then((img) => ({ assetId, img }))
          .catch(() => null)
      )
    ).then((loaded) => {
      if (cancelled) return;
      let didLoadAny = false;
      for (const entry of loaded) {
        if (!entry) continue;
        textSlideImagesRef.current[entry.assetId] = entry.img;
        didLoadAny = true;
      }
      if (cancelled) return;
      if (didLoadAny && isReady && !isPlaying) drawFrameAt(pausedAtSecondsRef.current);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drawFrameAt is freshly defined every render and always closes over the latest crop/zoom props
  }, [clips, assetUrlById, isReady, isPlaying]);

  // Extracts every video overlay's own source asset's preview frames once
  // (cached in videoOverlayFramesByAssetIdRef by assetId, shared across
  // multiple overlay clips reusing the same asset), sequentially --
  // independent of the main clips-loading effect above, so adding/adjusting
  // an overlay doesn't re-extract the base sequence's own frames. Same
  // pipeline the main sequence uses (extractPreviewFrames/
  // pickPreviewFrameRate), not a live seeked <video> -- see this file's
  // module comment on why the base sequence already works this way. A
  // source that fails to load is skipped -- drawFrameAt just shows nothing
  // for that overlay's window rather than erroring.
  const videoOverlayAssetIds = Array.from(new Set(videoOverlays.map((overlay) => overlay.assetId)));
  const videoOverlaysLoadKey = videoOverlayAssetIds.map((assetId) => `${assetId}:${assetUrlById[assetId] ?? ""}`).join(",");
  useEffect(() => {
    let cancelled = false;

    async function loadVideoOverlayFrames() {
      for (const assetId of videoOverlayAssetIds) {
        if (cancelled) return;
        if (videoOverlayFramesByAssetIdRef.current[assetId]) continue;
        const url = assetUrlById[assetId];
        if (!url) continue;
        try {
          const duration = await getVideoDuration(url);
          const frameRate = pickPreviewFrameRate(duration, navigator.hardwareConcurrency || 4);
          const images = await extractPreviewFrames(url, frameRate);
          if (cancelled) return;
          videoOverlayFramesByAssetIdRef.current[assetId] = { images, frameRate, durationSeconds: duration };
          if (isReady && !isPlaying) drawFrameAt(pausedAtSecondsRef.current);
        } catch {
          // Skipped -- drawFrameAt just shows nothing for this overlay's window.
        }
      }
    }

    void loadVideoOverlayFrames();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on videoOverlaysLoadKey (joined assetId:url), not the videoOverlays array reference; drawFrameAt is freshly defined every render and always closes over the latest props
  }, [videoOverlaysLoadKey, isReady, isPlaying]);

  // AI background removal for a video overlay -- separate from the frame-
  // extraction effect above since its own key (videoOverlayRemovalLoadKey,
  // below) must react to matteAssetId arriving LATER (once VEED's async job
  // completes and ThreePaneEditor's requestAndPollVideoOverlayBackgroundRemoval
  // patches it in) even after this asset's frames are already cached --
  // nesting this inside the frames effect's own "not yet cached" branch
  // would miss that update entirely, since that branch is skipped once
  // videoOverlayFramesByAssetIdRef already has an entry for this assetId.
  // Same real-matte-or-approximate-fallback staging as loadClipAt's own
  // video branch above (see this file's module comment on the two-stage
  // live preview) -- one overlay clip per asset needs backgroundRemoval
  // enabled for every overlay sharing that asset to get keyed out, same
  // per-assetId sharing as the frames themselves.
  const videoOverlayRemovalLoadKey = videoOverlayAssetIds
    .map((assetId) => {
      const overlay = videoOverlays.find((o) => o.assetId === assetId && o.backgroundRemoval?.enabled);
      if (!overlay) return "";
      const matteAssetId = overlay.backgroundRemoval?.matteAssetId ?? "";
      // mode/chromaKeyColor included even though neither is ever changed
      // after add-time today (VideoOverlayClip.backgroundRemoval's own doc
      // comment) -- cheap correctness if that ever stops being true.
      return `${assetId}:${overlay.backgroundRemoval?.mode ?? "ai"}:${overlay.backgroundRemoval?.chromaKeyColor ?? ""}:${matteAssetId}:${assetUrlById[matteAssetId] ?? ""}`;
    })
    .join(",");
  useEffect(() => {
    let cancelled = false;

    async function loadVideoOverlayMattes() {
      for (const assetId of videoOverlayAssetIds) {
        if (cancelled) return;
        const overlay = videoOverlays.find((o) => o.assetId === assetId && o.backgroundRemoval?.enabled);
        if (!overlay) continue;
        const matteAssetId = overlay.backgroundRemoval?.matteAssetId ?? null;
        const matteUrl = matteAssetId ? assetUrlById[matteAssetId] : undefined;
        // Once the real matte's ready, replace whatever approximate mask (or
        // nothing) is cached -- re-keyed into videoOverlayRemovalLoadKey via
        // the matteAssetId component above, so this only re-runs when that
        // actually changes.
        try {
          // The sibling frames-extraction effect above runs concurrently,
          // not necessarily finished by the time this effect's own first
          // pass reaches this assetId (real matte doesn't need frames at
          // all, but the approximate fallback runs MediaPipe against these
          // same frames) -- a short bounded wait rather than giving up and
          // leaving this overlay undrawn until some unrelated key change
          // happens to re-run this effect.
          const isChromaKey = overlay.backgroundRemoval?.mode === "chromaKey";
          let frames = videoOverlayFramesByAssetIdRef.current[assetId];
          // Chroma key never waits on matteUrl -- it never requests a fal.ai
          // job at all (see chromaKey.ts's own module comment) -- only wait
          // here for the frames it keys against locally.
          for (let attempt = 0; !frames && (isChromaKey || !matteUrl) && attempt < 25 && !cancelled; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            frames = videoOverlayFramesByAssetIdRef.current[assetId];
          }
          // Chroma key ALWAYS keys locally, for both preview and the actual
          // Edge Render output -- see lib/video/chromaKey.ts's own module
          // comment on why it never swaps to a real fal.ai matte the way
          // "ai" mode does.
          const mattes = isChromaKey
            ? frames
              ? await chromaKeyFramesToAlphaMasks(frames.images, overlay.backgroundRemoval?.chromaKeyColor ?? DEFAULT_CHROMA_KEY_COLOR)
              : null
            : matteUrl
              ? await lumaFramesToAlphaMasks(await extractPreviewFrames(matteUrl, frames?.frameRate ?? pickPreviewFrameRate(frames?.durationSeconds ?? 0, navigator.hardwareConcurrency || 4)))
              : frames
                ? await segmentClipFramesApproximate(frames.images)
                : null;
          if (cancelled || !mattes) continue;
          videoOverlayMattesByAssetIdRef.current[assetId] = mattes;
          if (isReady && !isPlaying) drawFrameAt(pausedAtSecondsRef.current);
        } catch (err) {
          console.error("background-removal mask extraction failed for video overlay asset=%s", assetId, err);
        }
      }
    }

    void loadVideoOverlayMattes();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on videoOverlayRemovalLoadKey; drawFrameAt is freshly defined every render and always closes over the latest props
  }, [videoOverlayRemovalLoadKey, isReady, isPlaying]);

  // AI/chroma-key background removal for an IMAGE overlay -- unlike the
  // video-overlay pair above, an image overlay is a single static photo, so
  // this follows the base sequence's still-image cutaway path instead (see
  // imageOverlayCutoutsByAssetIdRef's own comment): the cutout REPLACES the
  // plain photo outright rather than being composited via a separate alpha
  // mask. Own key (same shape as videoOverlayRemovalLoadKey above) so a
  // later-arriving matteAssetId (once ThreePaneEditor's
  // requestAndPollImageOverlayBackgroundRemoval patches it in) still
  // triggers a re-run even after this asset's plain photo is already
  // cached.
  const imageOverlayAssetIds = Array.from(new Set(overlayImages.map((overlay) => overlay.assetId)));
  const imageOverlayRemovalLoadKey = imageOverlayAssetIds
    .map((assetId) => {
      const overlay = overlayImages.find((o) => o.assetId === assetId && o.backgroundRemoval?.enabled);
      if (!overlay) return "";
      const matteAssetId = overlay.backgroundRemoval?.matteAssetId ?? "";
      return `${assetId}:${overlay.backgroundRemoval?.mode ?? "ai"}:${overlay.backgroundRemoval?.chromaKeyColor ?? ""}:${matteAssetId}:${assetUrlById[matteAssetId] ?? ""}`;
    })
    .join(",");
  useEffect(() => {
    let cancelled = false;

    async function loadImageOverlayCutouts() {
      for (const assetId of imageOverlayAssetIds) {
        if (cancelled) return;
        const overlay = overlayImages.find((o) => o.assetId === assetId && o.backgroundRemoval?.enabled);
        if (!overlay) continue;
        const matteAssetId = overlay.backgroundRemoval?.matteAssetId ?? null;
        const matteUrl = matteAssetId ? assetUrlById[matteAssetId] : undefined;
        try {
          // The sibling overlay-image loading effect runs concurrently, not
          // necessarily finished by the time this effect's own first pass
          // reaches this assetId -- a short bounded wait rather than giving
          // up, same reasoning as videoOverlayRemovalLoadKey's identical
          // wait for its own frames.
          let plainImage = overlayImagesRef.current[assetId];
          for (let attempt = 0; !plainImage && attempt < 25 && !cancelled; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            plainImage = overlayImagesRef.current[assetId];
          }
          if (!plainImage) continue;
          // Chroma key ALWAYS keys locally (see lib/video/chromaKey.ts's own
          // module comment); "ai" mode uses the real matte once resolved,
          // else the same instant approximate cutout the base sequence's
          // own image branch falls back to while its job is in flight.
          const isChromaKey = overlay.backgroundRemoval?.mode === "chromaKey";
          const cutout = isChromaKey
            ? await chromaKeyImageToBitmap(plainImage, overlay.backgroundRemoval?.chromaKeyColor ?? DEFAULT_CHROMA_KEY_COLOR)
            : matteUrl
              ? await loadImage(matteUrl)
              : await segmentImageApproximate(plainImage);
          if (cancelled) continue;
          imageOverlayCutoutsByAssetIdRef.current[assetId] = cutout;
          if (isReady && !isPlaying) drawFrameAt(pausedAtSecondsRef.current);
        } catch (err) {
          console.error("background-removal cutout failed for image overlay asset=%s", assetId, err);
        }
      }
    }

    void loadImageOverlayCutouts();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on imageOverlayRemovalLoadKey; drawFrameAt is freshly defined every render and always closes over the latest props
  }, [imageOverlayRemovalLoadKey, isReady, isPlaying]);

  // Decodes audio ONLY for a video overlay source asset that at least one
  // overlay actually wants some audio from (audioBalance > 0) -- most
  // overlays never touch audio at all, so this stays a no-op for them.
  // Independent of the frame-extraction effect above (frames still load
  // regardless of audioBalance) and of the main sequence's own decode.
  // Takes effect on the NEXT resumePlaybackFrom (Play, or a seek while
  // playing) -- unlike video frames, there's no way to hot-swap audio
  // already scheduled mid-playback, so a buffer finishing decode while
  // already playing doesn't retroactively add its sound until the next
  // resume. A source that fails to decode is skipped -- the base track
  // simply isn't ducked for that overlay's window (see
  // computeAudioMixBreakpoints, which only ducks based on audioBalance, not
  // on whether the buffer actually loaded).
  const overlayAudioAssetIds = Array.from(new Set(videoOverlays.filter((o) => o.audioBalance > 0).map((o) => o.assetId)));
  const overlayAudioLoadKey = overlayAudioAssetIds.map((assetId) => `${assetId}:${assetUrlById[assetId] ?? ""}`).join(",");
  useEffect(() => {
    let cancelled = false;

    async function loadOverlayAudio() {
      for (const assetId of overlayAudioAssetIds) {
        if (cancelled) return;
        if (videoOverlayAudioBuffersByAssetIdRef.current[assetId]) continue;
        const url = assetUrlById[assetId];
        if (!url) continue;
        try {
          // decodeAudioBuffer manages its own temporary AudioContext
          // internally -- unrelated to audioContextRef/ensureAudioContext,
          // which is only for the playback graph itself.
          const buffer = await decodeAudioBuffer(url);
          if (cancelled) return;
          videoOverlayAudioBuffersByAssetIdRef.current[assetId] = buffer;
        } catch {
          // Skipped -- see this effect's own comment.
        }
      }
    }

    void loadOverlayAudio();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on overlayAudioLoadKey (joined assetId:url), not the videoOverlays array reference
  }, [overlayAudioLoadKey]);

  // Decodes every TTS narration overlay's own generated audio, independent
  // of the main clips-loading effect (adding/editing a narration shouldn't
  // re-extract every video frame from scratch) -- unlike video-overlay
  // audio above, this always decodes (a narration overlay's whole point is
  // its audio, there's no audioBalance opt-out to check). Takes effect on
  // the NEXT resumePlaybackFrom, same as every other audio buffer here.
  const ttsAssetIds = Array.from(new Set(ttsOverlays.map((overlay) => overlay.assetId)));
  const ttsAudioLoadKey = ttsAssetIds.map((assetId) => `${assetId}:${assetUrlById[assetId] ?? ""}`).join(",");
  useEffect(() => {
    let cancelled = false;

    async function loadTtsAudio() {
      for (const assetId of ttsAssetIds) {
        if (cancelled) return;
        if (ttsAudioBuffersByAssetIdRef.current[assetId]) continue;
        const url = assetUrlById[assetId];
        if (!url) continue;
        try {
          const buffer = await decodeAudioBuffer(url);
          if (cancelled) return;
          ttsAudioBuffersByAssetIdRef.current[assetId] = buffer;
        } catch {
          // Skipped -- this overlay's window just plays silently until a
          // later successful decode (e.g. once assetUrlById refreshes with
          // a valid presigned URL).
        }
      }
    }

    void loadTtsAudio();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on ttsAudioLoadKey (joined assetId:url), not the ttsOverlays array reference
  }, [ttsAudioLoadKey]);

  // Decodes audio for every distinct music-clip source asset, independent
  // of the main clips-loading effect above, so adding/moving a music clip
  // never re-extracts a single video frame. Same per-assetId cache/dedupe as
  // overlayAudioAssetIds/loadOverlayAudio above; unlike that one, every
  // music asset always gets decoded (no per-clip audio opt-out). A clip
  // whose source fails to decode is skipped -- that one clip's window
  // simply plays without sound, same policy as a failed video-overlay/TTS
  // decode, not an error that blocks the rest.
  const musicClipAssetIds = Array.from(new Set(musicClips.map((clip) => clip.assetId)));
  const musicClipLoadKey = musicClipAssetIds.map((assetId) => `${assetId}:${assetUrlById[assetId] ?? ""}`).join(",");
  useEffect(() => {
    let cancelled = false;

    async function loadMusicAudio() {
      for (const assetId of musicClipAssetIds) {
        if (cancelled) return;
        if (musicAudioBuffersByAssetIdRef.current[assetId]) continue;
        const url = assetUrlById[assetId];
        if (!url) continue;
        try {
          const buffer = await decodeAudioBuffer(url);
          if (cancelled) return;
          musicAudioBuffersByAssetIdRef.current[assetId] = buffer;
          // "Pulse with music" -- distilled once here from the same buffer
          // playback uses, see audioReactive.ts's own doc comment.
          musicEnvelopesByAssetIdRef.current[assetId] = computeAudioEnvelope(buffer);
        } catch {
          // Skipped -- see this effect's own comment.
        }
      }
    }

    void loadMusicAudio();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on musicClipLoadKey (joined assetId:url), not the musicClips array reference
  }, [musicClipLoadKey]);

  useEffect(() => {
    return () => {
      stopPlaybackLoop();
      audioContextRef.current?.close();
      camera3DRendererRef.current?.dispose();
      camera3DRendererRef.current = null;
    };
  }, []);

  if (error) {
    return (
      <p className="p-4 text-sm text-red-600">
        {error} -- if this looks like a CORS/security error, the R2 uploads bucket needs its CORS policy configured
        (see DEPLOY.md / backend/scripts/configure_r2_cors.py).
      </p>
    );
  }

  // lib/localRender/exportTimeline.ts still has no knowledge of Creatomate's
  // server-side speech transcription -- transcript captions stay gated on
  // the cloud Render button until/unless a client-side transcription path
  // exists.
  const hasTranscriptCaption = Boolean(renderControls?.transcriptCaption);
  const renderDisabled =
    !renderControls ||
    !renderControls.canRender ||
    renderControls.isRendering ||
    (renderControls.renderStatus !== null && !TERMINAL_RENDER_STATUSES.has(renderControls.renderStatus));
  const localRenderDisabled =
    !renderControls ||
    !renderControls.canLocalRender ||
    renderControls.isLocalRendering ||
    hasTranscriptCaption ||
    !renderControls.isLocalRenderSupported;
  const localRenderTitle = !renderControls?.canLocalRender
    ? "Add a video before rendering"
    : hasTranscriptCaption
      ? "Edge Render doesn't support auto-captions yet — use Render instead"
      : !renderControls.isLocalRenderSupported
        ? (renderControls.localRenderUnsupportedReason ?? "Edge Render needs a Chromium browser (Chrome or Microsoft Edge)")
        : "Edge Render (in your browser, no cost)";

  return (
    // w-full/min-w-0 here, not just on the video box below -- this root sits
    // in ActionArea's `justify-end` wrapper, which shrink-wraps its child by
    // default. Without a definite width on THIS element, the video box's
    // flex-1 (flex-basis 0%) has nothing to grow into once the canvas went
    // absolute/out-of-flow (see below): the shrink-wrap collapses to just
    // the controls row's height and the video panel disappears entirely.
    // flex-col -- the controls row sits BELOW the video panel (not beside
    // it), same reasoning as CanvasPlayer's own module comment about
    // favoring direct-manipulation, uncluttered chrome: a strip under the
    // preview reads as a media player's transport bar, whereas a side rail
    // competed with the panel for the row's own width.
    <div
      ref={playerRootRef}
      className={
        "flex h-full w-full min-w-0 flex-col items-center gap-2 px-2" + (isFullscreen ? " bg-black" : "")
      }
      style={{ containerType: "size" }}
    >
      {/* This box IS the visible video panel -- flex-1/min-h-0/w-full so it
          takes whatever height this column has left rather than requesting
          its own intrinsic height (the previous h-full+w-auto-on-the-canvas
          approach sized this box from the canvas's own aspect ratio, which
          read fine until the column got tight -- e.g. a shorter browser
          window -- at which point the flexbox default (shrink:1) squeezed
          THIS box's height independently of its w-full width, stretching/
          squashing the frame inside it. object-contain on the canvas below
          is what actually pins the aspect ratio now: whatever box this ends
          up with, the canvas always letterboxes/pillarboxes inside it rather
          than distorting -- so this can shrink freely and safely).
          max-h-[235cqw] caps it at the widest real clip ratio (2.35:1
          cinematic widescreen) relative to ITS OWN width -- container query
          units, not a percentage of the column's height, since the column
          can be far taller than 2.35x wide (see the parent's own
          container-type: size above, which is what makes cqw resolve
          against this column's width instead of the nearest ancestor that
          happens to have one). Below that ratio (the vast majority of reels,
          which are portrait or square) flex-1 still governs the height
          exactly as before -- this only ever clamps DOWN from what flex-1
          would otherwise claim. */}
      <div className="relative w-full min-h-0 max-h-[235cqw] flex-1 overflow-hidden rounded-md border border-border bg-black">
        {/* absolute inset-0 + object-contain, not h-full/w-auto -- lets this
            fill whatever box the wrapper above ends up with while the
            canvas's own width/height attributes (set in drawFrameAt to the
            project's fixed real output resolution -- see this file's own
            module comment) still drive the frame's real aspect ratio via
            object-fit, immune to the wrapper being squeezed on resize (see
            its comment). */}
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full object-contain" />
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <ReelLoader stage={loadingStage} className="text-white" />
          </div>
        )}
        {partialLoadWarning && !isLoading && (
          <p className="absolute inset-x-0 bottom-0 bg-black/70 px-2 py-1 text-center text-[11px] text-yellow-300">
            {partialLoadWarning}
          </p>
        )}
        {/* Floats over the frame itself (top corner, like every short-form
            feed's own mute affordance) rather than living down in the
            below-panel controls row with Play/Loop/Fullscreen -- sound is
            the one control a viewer expects to reach without hunting for it. */}
        {isReady && (
          <button
            type="button"
            onClick={handleToggleMute}
            aria-label={isMuted ? "Unmute" : "Mute"}
            aria-pressed={isMuted}
            title={isMuted ? "Unmute" : "Mute"}
            className="absolute right-2 top-2 rounded-full bg-black/40 p-2 text-white backdrop-blur-sm hover:bg-black/60"
          >
            {isMuted ? <SpeakerMutedIcon className="h-4 w-4" /> : <SpeakerFullIcon className="h-4 w-4" />}
          </button>
        )}
      </div>

      {/* Icon-only, transparent background -- reads as video-player
          controls rather than generic form buttons -- below the video
          panel itself, in a row, own fixed height. */}
      {isReady && (
        <div className="flex shrink-0 flex-row items-center gap-1">
          {renderControls && (
            <>
              <button
                type="button"
                onClick={renderControls.onRenderClick}
                disabled={renderDisabled}
                aria-label="Render"
                title={renderControls.canRender ? "Render" : "Add a video before rendering"}
                className="shrink-0 rounded-full p-2 text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RenderIcon className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={renderControls.onLocalRenderClick}
                disabled={localRenderDisabled}
                aria-label="Edge Render"
                title={localRenderTitle}
                className="shrink-0 rounded-full p-2 text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <LocalRenderIcon className="h-5 w-5" />
              </button>
              <div className="mx-1 h-6 w-px shrink-0 bg-border" />
            </>
          )}
          <button
            type="button"
            onClick={handlePlayPause}
            aria-label={isPlaying ? "Pause" : "Play"}
            className="shrink-0 rounded-full p-2 text-accent hover:bg-accent/10"
          >
            {isPlaying ? <PauseIcon className="h-6 w-6" /> : <PlayIcon className="h-6 w-6" />}
          </button>
          <button
            type="button"
            onClick={handleToggleLoop}
            aria-label={isLooping ? "Turn off loop playback" : "Loop playback"}
            aria-pressed={isLooping}
            title="Loop playback"
            className={"shrink-0 rounded-full p-2 hover:bg-accent/10 " + (isLooping ? "text-accent" : "text-muted")}
          >
            <LoopIcon className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={handleToggleFullscreen}
            aria-label={isFullscreen ? "Exit full window" : "Full window"}
            aria-pressed={isFullscreen}
            title={isFullscreen ? "Exit full window" : "Full window"}
            className={"shrink-0 rounded-full p-2 hover:bg-accent/10 " + (isFullscreen ? "text-accent" : "text-muted")}
          >
            {isFullscreen ? <CollapseIcon className="h-5 w-5" /> : <ExpandIcon className="h-5 w-5" />}
          </button>
        </div>
      )}
    </div>
  );
});
