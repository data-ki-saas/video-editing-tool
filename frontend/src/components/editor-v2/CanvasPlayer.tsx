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
 * `backgroundTracks` (resolved {name, url}[], same list BackgroundTrackStrip
 * visualizes) plays here too, mixed under the main clip audio at a fixed,
 * lower gain -- decoded/concatenated the same way as the main sequence's
 * audio (one buffer, looped via AudioBufferSourceNode.loop rather than
 * manually rescheduled, which naturally reproduces "the whole concatenated
 * sequence repeats across the video's duration"). Decoded in its own effect,
 * independent of the main clips-loading effect, so adding/changing a
 * background track doesn't re-extract every video frame from scratch; if
 * it's still decoding (or absent) when Play is pressed, the clip simply
 * plays without music that time around rather than blocking playback on it.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { extractPreviewFrames, getVideoDuration, drawImageFlipped } from "@/lib/video/video";
import { decodeAudioBuffer, concatenateAudioBuffers } from "@/lib/video/audio";
import {
  frameIndexAtTime,
  pickPreviewFrameRate,
  computeEffectiveCropRect,
  reprojectCropRect,
  computeEffectiveFlip,
  skipTrimmedRanges,
  findActiveTextOverlays,
  findActiveExclusiveOverlay,
  findActivePictureInPictureOverlays,
  computeOverlayRects,
  computeCoverFitSourceRect,
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
  FULL_FRAME_CROP_RECT,
  type CropRect,
  type ImageOverlayClip,
  type SequenceClipInfo,
  type SequenceEntry,
  type TextOverlay,
  type TtsOverlay,
  type VideoOverlayClip,
  type TrimRange,
  type ZoomEffect,
} from "@/lib/video/video_math";
import { getTextTemplateRenderer, drawKaraokeCaption } from "@/lib/video/textTemplates";
import { getFilterPresetOption } from "@/lib/video/filterPresets";
import type { CutTransitionId } from "@/lib/video/cutTransitionPresets";
import { loadCrossOriginImage } from "@/lib/crossOriginImage";
import { ReelLoader } from "@/components/ReelLoader";
import { PlayIcon, PauseIcon, LoopIcon } from "./icons/PlayerIcons";

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
    // Resolved background-music sequence (project assets and/or a curated
    // catalog track) -- mixed into playback here, see this file's module
    // comment. Empty when no background track is selected.
    backgroundTracks: { name: string; url: string }[];
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
    backgroundTracks,
    mainAudioVolume,
    backgroundVolume,
    onFrameDimensions,
    onTimeUpdate,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Each clip's own filter, keyed by SequenceEntry.id -- looked up by id
  // (via loadedClipsRef's own `.id`, see its comment below) rather than by
  // position, since a clip that failed to load shifts every later index out
  // of alignment with the `clips` prop.
  const clipFilterById = new Map(clips.map((clip) => [clip.id, clip.colorFilterId ?? null]));
  // Which cut-transition (see cutTransitionPresets.ts) plays INTO each clip
  // from whichever clip precedes it -- same id-keyed lookup shape as
  // clipFilterById above. Distinct from this codebase's OTHER "transition"
  // (the pan/zoom Ken Burns effect) -- see video_math.ts's
  // SequenceEntry.cutTransitionInId doc comment.
  const cutTransitionById: Map<string, CutTransitionId | null | undefined> = new Map(
    clips.map((clip) => [clip.id, clip.cutTransitionInId ?? null])
  );
  // Per-clip decoded preview frames + frame rate, indexed the same as
  // loadedClipsRef below (NOT necessarily the same as the `clips` prop --
  // a clip that failed to load is excluded from all three in lockstep). A
  // "video" clip's frames are ImageBitmaps straight from extractPreviewFrames
  // (see video.ts); an "image" clip holds a single real HTMLImageElement
  // loaded from its own URL -- both support the .width/.height/drawImage
  // this file needs, so they're used interchangeably below.
  const clipImagesRef = useRef<(HTMLImageElement | ImageBitmap)[][]>([]);
  const frameRatesRef = useRef<number[]>([]);
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
  // Extracted preview frames for every video overlay's own source asset,
  // keyed by assetId (shared across multiple overlay clips reusing the
  // same asset, not per-clip) -- same extractPreviewFrames/frameIndexAtTime
  // pipeline the main sequence's own clips use below, not a live seeked
  // <video> or a single static image, since a video overlay must actually
  // play back over its window.
  const videoOverlayFramesByAssetIdRef = useRef<Record<string, { images: ImageBitmap[]; frameRate: number; durationSeconds: number }>>({});
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
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  // Background-music sequence, decoded/concatenated independently of the
  // main clips (see this file's module comment) -- null while loading or
  // absent, checked at play/seek time rather than gating isReady on it.
  const backgroundAudioBufferRef = useRef<AudioBuffer | null>(null);
  const backgroundSourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
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
    if (!audioContextRef.current) audioContextRef.current = new AudioContext();
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
    try {
      backgroundSourceNodeRef.current?.stop();
    } catch {
      // Already stopped -- fine to ignore.
    }
    backgroundSourceNodeRef.current = null;
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
    const images = clipImagesRef.current[position.clipIndex];
    if (!images || images.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

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
    } else if (baseRect) {
      // null only for an active Full-Screen video overlay -- the overlay's
      // own draw below fully covers the canvas at full opacity regardless,
      // so skipping this is a pure optimization, never load-bearing for
      // correctness (see video_math.ts's computeOverlayRects doc comment).
      // Not Split-Screen here, so baseRect always matches crop's own
      // aspect (the full canvas) -- no further cover-fit needed.
      ctx.drawImage(
        image, sx, sy, sWidth, sHeight,
        baseRect.x * canvas.width, baseRect.y * canvas.height, baseRect.width * canvas.width, baseRect.height * canvas.height
      );
    }
    ctx.restore();

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
      const overlayImage = overlayImagesRef.current[activeExclusiveImageOverlay.assetId];
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
        drawImageFlipped(
          ctx, overlayImage, osx, osy, osw, osh, destX, destY, destWidth, destHeight,
          activeExclusiveImageOverlay.framing.flipHorizontal, activeExclusiveImageOverlay.framing.flipVertical
        );
        ctx.filter = "none";
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
        drawImageFlipped(
          ctx, overlayImage, osx, osy, osw, osh, destX, destY, destWidth, destHeight,
          activeExclusiveVideoOverlay.framing.flipHorizontal, activeExclusiveVideoOverlay.framing.flipVertical
        );
        ctx.filter = "none";
      }
    }

    // Picture-in-Picture VIDEO overlays float on top of whatever's showing
    // (the base clip, or an active Full-Screen/Split-Screen overlay above)
    // -- unlike the exclusive layouts, any number can be active at once.
    for (const pip of findActivePictureInPictureOverlays(videoOverlays, elapsedSeconds)) {
      if (pip.layout.type !== "picture-in-picture") continue; // narrows the type for pip.layout.rect below
      const frames = videoOverlayFramesByAssetIdRef.current[pip.assetId];
      if (!frames) continue;
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
        pipImage.width, pipImage.height, destWidth, destHeight, pip.framing.panX, pip.framing.panY, pip.framing.zoom
      );
      ctx.filter = getFilterPresetOption(pip.colorFilterId ?? null).cssFilter;
      drawImageFlipped(ctx, pipImage, psx, psy, psw, psh, destX, destY, destWidth, destHeight, pip.framing.flipHorizontal, pip.framing.flipVertical);
      ctx.filter = "none";
    }

    // Picture-in-Picture IMAGE overlays draw AFTER video PiP overlays, so
    // an image PiP wins visually if it happens to overlap a video PiP box
    // -- same "image wins" convention as the exclusive layer above.
    for (const pip of findActivePictureInPictureOverlays(overlayImages, elapsedSeconds)) {
      if (pip.layout.type !== "picture-in-picture") continue; // narrows the type for pip.layout.rect below
      const overlayImage = overlayImagesRef.current[pip.assetId];
      if (!overlayImage) continue;
      const destX = pip.layout.rect.x * canvas.width;
      const destY = pip.layout.rect.y * canvas.height;
      const destWidth = pip.layout.rect.width * canvas.width;
      const destHeight = pip.layout.rect.height * canvas.height;
      const { sx: psx, sy: psy, sWidth: psw, sHeight: psh } = computeCoverFitSourceRect(
        overlayImage.width, overlayImage.height, destWidth, destHeight, pip.framing.panX, pip.framing.panY, pip.framing.zoom
      );
      ctx.filter = getFilterPresetOption(pip.colorFilterId ?? null).cssFilter;
      drawImageFlipped(ctx, overlayImage, psx, psy, psw, psh, destX, destY, destWidth, destHeight, pip.framing.flipHorizontal, pip.framing.flipVertical);
      ctx.filter = "none";
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
    source.connect(mainGainNode).connect(audioContext.destination);
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
      overlaySource.connect(overlayGainNode).connect(audioContext.destination);
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
      ttsSource.connect(ttsGainNode).connect(audioContext.destination);
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
      previewSource.connect(previewGainNode).connect(audioContext.destination);
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

    // Background music loops on its own (loop = true over the whole
    // buffer) rather than being rescheduled per repeat -- its start offset
    // is taken modulo its own duration so resuming partway through the
    // main sequence lands at the right phase within the loop, matching
    // what BackgroundTrackStrip visualizes.
    const backgroundBuffer = backgroundAudioBufferRef.current;
    if (backgroundBuffer && backgroundBuffer.duration > 0) {
      const backgroundSource = audioContext.createBufferSource();
      backgroundSource.buffer = backgroundBuffer;
      backgroundSource.loop = true;
      const gainNode = audioContext.createGain();
      gainNode.gain.value = backgroundVolume;
      backgroundSource.connect(gainNode).connect(audioContext.destination);
      backgroundSource.start(0, adjustedOffsetSeconds % backgroundBuffer.duration);
      backgroundSourceNodeRef.current = backgroundSource;
    }

    setIsPlaying(true);
    animationFrameIdRef.current = requestAnimationFrame(tick);
  }

  function handlePlayPause() {
    if (!isReady) return;

    if (isPlaying) {
      const audioContext = audioContextRef.current;
      if (audioContext) {
        pausedAtSecondsRef.current += audioContext.currentTime - playStartedAtCtxTimeRef.current;
      }
      stopPlaybackLoop();
      setIsPlaying(false);
      onTimeUpdate?.(pausedAtSecondsRef.current);
      return;
    }

    resumePlaybackFrom(pausedAtSecondsRef.current);
  }

  function handleToggleLoop() {
    const next = !isLooping;
    setIsLooping(next);
    isLoopingRef.current = next;
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
    loadedClipsRef.current = [];
    audioBufferRef.current = null;
    pausedAtSecondsRef.current = 0;
    onTimeUpdate?.(0);

    async function load() {
      if (clips.length === 0) return;
      const audioContext = ensureAudioContext();

      type LoadedClipMeta = { id: string; assetId: string; url: string; durationSeconds: number; kind: "video" | "image" };
      type ClipLoadResult =
        | { ok: true; images: (HTMLImageElement | ImageBitmap)[]; frameRate: number; audioBuffer: AudioBuffer; meta: LoadedClipMeta }
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
          if (clip.kind === "image") {
            // An image clip is "a video with exactly one frame, held for
            // its authored duration, with silent audio" -- no file to
            // probe/decode. frameIndexAtTime already clamps to
            // frameCount - 1, so a single-frame array naturally holds that
            // one frame for the whole clip with no other changes needed.
            const duration = clip.durationSeconds;
            const image = await loadImage(clip.url);
            const silentAudioBuffer = audioContext.createBuffer(1, Math.max(1, Math.round(duration * audioContext.sampleRate)), audioContext.sampleRate);
            clipProgress[index] = 1;
            reportProgress();
            return {
              ok: true,
              images: [image],
              frameRate: 1,
              audioBuffer: silentAudioBuffer,
              meta: { id: clip.id, assetId: clip.assetId, url: clip.url, durationSeconds: duration, kind: "image" },
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
          return {
            ok: true,
            images,
            frameRate,
            audioBuffer,
            meta: { id: clip.id, assetId: clip.assetId, url: clip.url, durationSeconds: duration, kind: "video" },
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
      let failureCount = 0;
      let lastFailureMessage = "";
      for (const result of results) {
        if (result.ok) {
          loadedImages.push(result.images);
          loadedFrameRates.push(result.frameRate);
          loadedAudioBuffers.push(result.audioBuffer);
          loadedClipMeta.push(result.meta);
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
      loadedClipsRef.current = buildSequenceClipInfos(loadedClipMeta);
      durationRef.current = totalSequenceDuration(loadedClipsRef.current);
      audioBufferRef.current = concatenateAudioBuffers(audioContext, loadedAudioBuffers);

      const firstImage = loadedImages[0]?.[0];
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
        overlayImagesRef.current[entry.assetId] = entry.img;
        didLoadAny = true;
      }
      if (didLoadAny && isReady && !isPlaying) drawFrameAt(pausedAtSecondsRef.current);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drawFrameAt is freshly defined every render and always closes over the latest crop/zoom props
  }, [overlayImages, assetUrlById, isReady, isPlaying]);

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

  // Decodes/concatenates the background-music sequence independently of the
  // main clips-loading effect above, so adding or swapping a background
  // track doesn't re-extract every video frame. A track that fails to
  // decode is skipped (same policy as a failed video clip); if every track
  // fails, playback just proceeds without music rather than erroring.
  const backgroundTracksKey = backgroundTracks.map((track) => track.url).join(",");
  useEffect(() => {
    let cancelled = false;
    backgroundAudioBufferRef.current = null;
    if (backgroundTracks.length === 0) return;

    async function loadBackgroundAudio() {
      const audioContext = ensureAudioContext();
      const decoded: AudioBuffer[] = [];
      for (const track of backgroundTracks) {
        if (cancelled) return;
        try {
          decoded.push(await decodeAudioBuffer(track.url));
        } catch {
          // Skipped -- one bad background track shouldn't block the rest.
        }
      }
      if (cancelled || decoded.length === 0) return;
      backgroundAudioBufferRef.current = concatenateAudioBuffers(audioContext, decoded);
    }

    void loadBackgroundAudio();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on backgroundTracksKey (joined urls), not the backgroundTracks array reference
  }, [backgroundTracksKey]);

  useEffect(() => {
    return () => {
      stopPlaybackLoop();
      audioContextRef.current?.close();
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

  return (
    // w-full/min-w-0 here, not just on the video box below -- this root sits
    // in ActionArea's `justify-end` wrapper, which shrink-wraps its child by
    // default. Without a definite width on THIS element, the video box's
    // flex-1 (flex-basis 0%) has nothing to grow into once the canvas went
    // absolute/out-of-flow (see below): the shrink-wrap collapses to just
    // the controls column's width and the video panel disappears entirely.
    <div className="flex h-full w-full min-w-0 items-center gap-2 p-2" style={{ containerType: "size" }}>
      {/* This box IS the visible video panel -- flex-1/min-w-0 so it takes
          whatever width this row has left rather than requesting its own
          intrinsic width (the previous h-full+w-auto-on-the-canvas approach
          sized this box from the canvas's own aspect ratio, which read fine
          until the row got tight -- e.g. a narrower browser window -- at
          which point the flexbox default (shrink:1) squeezed THIS box's
          width independently of its h-full height, stretching/squashing the
          frame inside it. object-contain on the canvas below is what
          actually pins the aspect ratio now: whatever box this ends up
          with, the canvas always letterboxes/pillarboxes inside it rather
          than distorting -- so this can shrink freely and safely).
          max-w-[235cqh] caps it at the widest real clip ratio (2.35:1
          cinematic widescreen) relative to ITS OWN height -- container query
          units, not a percentage of the row's width, since the row can be
          far wider than 2.35x tall (see the parent's own container-type:
          size above, which is what makes cqh resolve against this row's
          height instead of the nearest ancestor that happens to have one).
          Below that ratio (the vast majority of reels, which are portrait or
          square) flex-1 still governs the width exactly as before -- this
          only ever clamps DOWN from what flex-1 would otherwise claim. */}
      <div className="relative h-full min-w-0 max-w-[235cqh] flex-1 overflow-hidden rounded-md border border-border bg-black">
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
      </div>

      {/* Icon-only, transparent background -- reads as video-player
          controls rather than generic form buttons -- outside the video
          panel itself, stacked vertically, own fixed width. */}
      {isReady && (
        <div className="flex shrink-0 flex-col items-center gap-1">
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
        </div>
      )}
    </div>
  );
});
