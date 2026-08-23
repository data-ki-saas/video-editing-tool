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
 * (lib/video/audio.ts's decodeAudioBuffer) SEQUENTIALLY (bounds peak
 * memory -- decoding fully loads a whole file into memory with no
 * streaming), then concatenates the decoded buffers into ONE continuous
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
 * Canvas pixel size is fixed once per sequence load (from the first loaded
 * clip's first frame's natural size) rather than recomputed from whichever
 * frame is currently drawn -- different clips can have different native
 * resolutions, and recomputing per-frame would visibly resize the canvas
 * at every clip boundary. It still responds live to the crop rect's own
 * ratio changing (just always scaled against that one fixed reference
 * resolution, not the current frame's own size) -- and, as a side effect,
 * a zoom-in now renders at full canvas resolution instead of shrinking the
 * canvas's own pixel size while zoomed (a visible sharpness improvement,
 * not a regression).
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
import { extractPreviewFrames, getVideoDuration } from "@/lib/video/video";
import { decodeAudioBuffer, concatenateAudioBuffers } from "@/lib/video/audio";
import {
  frameIndexAtTime,
  pickPreviewFrameRate,
  computeEffectiveCropRect,
  computeEffectiveFlip,
  skipTrimmedRanges,
  findActiveOverlays,
  findActiveTextOverlays,
  computeProgress,
  buildSequenceClipInfos,
  totalSequenceDuration,
  resolveSequencePosition,
  FULL_FRAME_CROP_RECT,
  type CropRect,
  type OverlayImage,
  type SequenceClipInfo,
  type TextOverlay,
  type TrimRange,
  type ZoomEffect,
} from "@/lib/video/video_math";
import { getTextTemplateRenderer } from "@/lib/video/textTemplates";
import { ReelLoader } from "@/components/ReelLoader";
import { PlayIcon, PauseIcon, LoopIcon } from "./icons/PlayerIcons";

export interface CanvasPlayerHandle {
  seekTo(seconds: number): void;
}

// Keeps background music audible under the main clip's own audio without
// drowning it out -- no volume control exposed for it (v1), matching this
// app's "smart default over exposing every knob" bias.
const BACKGROUND_MUSIC_GAIN = 0.5;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode an extracted preview frame"));
    img.src = src;
  });
}

export const CanvasPlayer = forwardRef<
  CanvasPlayerHandle,
  {
    // Every video clip in the sequence, in order -- see this file's module
    // comment and video_math.ts's SequenceClipInfo/resolveSequencePosition.
    clips: { assetId: string; url: string }[];
    baseCropRect: CropRect | null;
    zoomEffects: ZoomEffect[];
    // Overrides the computed crop for the CURRENT static frame while
    // paused -- lets the player preview a drag happening on FrameStrip's
    // active tile live, before it's committed. Never applied during
    // playback (dragging and playing at once isn't a real scenario).
    liveCropRectOverride?: CropRect | null;
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
    // range (see video_math.ts's OverlayImage) -- `assetUrlById` resolves
    // each overlay's assetId to the actual R2 URL to load and draw, kept
    // separate from OverlayImage itself since that's persisted state and
    // has no business holding a URL that expires.
    overlayImages: OverlayImage[];
    // Text captions composited on top of the base frame, rendered via a
    // named template (see lib/video/textTemplates.ts) -- drawn after image
    // overlays, so text always sits above them.
    textOverlays: TextOverlay[];
    assetUrlById: Record<string, string>;
    // Resolved background-music sequence (project assets and/or a curated
    // catalog track) -- mixed into playback here, see this file's module
    // comment. Empty when no background track is selected.
    backgroundTracks: { name: string; url: string }[];
    onFrameDimensions?: (dimensions: { width: number; height: number }) => void;
    onTimeUpdate?: (seconds: number) => void;
  }
>(function CanvasPlayer(
  {
    clips,
    baseCropRect,
    zoomEffects,
    liveCropRectOverride = null,
    flipHorizontalToggles,
    flipVerticalToggles,
    trimRanges,
    overlayImages,
    textOverlays,
    assetUrlById,
    backgroundTracks,
    onFrameDimensions,
    onTimeUpdate,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Per-clip decoded preview frames + frame rate, indexed the same as
  // loadedClipsRef below (NOT necessarily the same as the `clips` prop --
  // a clip that failed to load is excluded from all three in lockstep).
  const clipImagesRef = useRef<HTMLImageElement[][]>([]);
  const frameRatesRef = useRef<number[]>([]);
  // Which clips actually loaded, with cumulative start times -- what
  // resolveSequencePosition resolves elapsedSeconds against, and what
  // durationRef.current is derived from (their total).
  const loadedClipsRef = useRef<SequenceClipInfo[]>([]);
  const durationRef = useRef(0);
  // Fixed once per sequence load, from the first loaded clip's first
  // frame -- see this file's module comment on why canvas size is no
  // longer recomputed from whichever frame is currently drawn.
  const referenceFrameSizeRef = useRef({ width: 0, height: 0 });
  // Loaded overlay images, keyed by assetId -- populated asynchronously
  // (see the loading effect below), so drawFrameAt just skips an overlay
  // whose image hasn't resolved yet rather than waiting on it.
  const overlayImagesRef = useRef<Record<string, HTMLImageElement>>({});

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

    const crop = liveCropRectOverride ?? (baseCropRect ? computeEffectiveCropRect(baseCropRect, zoomEffects, elapsedSeconds) : FULL_FRAME_CROP_RECT);

    // Source rect: sampled from THIS frame's own natural size (clips can
    // have different native resolutions). Destination (canvas) size: the
    // fixed reference resolution, so different clips scale into the same
    // pixel dimensions rather than resizing the canvas at each cut.
    const sx = crop.x * image.naturalWidth;
    const sy = crop.y * image.naturalHeight;
    const sWidth = crop.width * image.naturalWidth;
    const sHeight = crop.height * image.naturalHeight;

    const targetWidth = Math.max(1, Math.round(crop.width * referenceFrameSizeRef.current.width));
    const targetHeight = Math.max(1, Math.round(crop.height * referenceFrameSizeRef.current.height));
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }

    const flipHorizontal = computeEffectiveFlip(flipHorizontalToggles, elapsedSeconds);
    const flipVertical = computeEffectiveFlip(flipVerticalToggles, elapsedSeconds);

    // Flip/mirror via the canvas transform, not by touching sx/sy/sWidth/
    // sHeight -- scale(-1) + translate the origin to the far edge maps the
    // same source region onto a horizontally/vertically reversed
    // destination, restored via ctx.restore() so it never leaks into the
    // next draw (this canvas is reused every frame).
    ctx.save();
    ctx.translate(flipHorizontal ? canvas.width : 0, flipVertical ? canvas.height : 0);
    ctx.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
    ctx.drawImage(image, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Composited AFTER the flip transform is undone (ctx.restore() above)
    // -- an overlay image is independent of the base clip's flip state,
    // not something that should mirror along with it.
    for (const overlay of findActiveOverlays(overlayImages, elapsedSeconds)) {
      const overlayImage = overlayImagesRef.current[overlay.assetId];
      if (!overlayImage) continue;
      ctx.drawImage(
        overlayImage,
        overlay.rect.x * canvas.width,
        overlay.rect.y * canvas.height,
        overlay.rect.width * canvas.width,
        overlay.rect.height * canvas.height
      );
    }

    // Text overlays draw last, always on top of image overlays.
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
  }

  function tick() {
    const audioContext = audioContextRef.current;
    if (!audioContext) return;

    const elapsed = pausedAtSecondsRef.current + (audioContext.currentTime - playStartedAtCtxTimeRef.current);

    // Crossed into a cut section -- jump the audio source itself forward
    // to just past it (not just what's drawn), so audio and video stay in
    // sync through the cut rather than the picture skipping while the
    // audio keeps playing the deleted stretch underneath.
    const skippedElapsed = skipTrimmedRanges(trimRanges, elapsed);
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

    const adjustedOffsetSeconds = Math.min(skipTrimmedRanges(trimRanges, offsetSeconds), durationRef.current);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start(0, adjustedOffsetSeconds);
    sourceNodeRef.current = source;
    playStartedAtCtxTimeRef.current = audioContext.currentTime;
    pausedAtSecondsRef.current = adjustedOffsetSeconds;

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
      gainNode.gain.value = BACKGROUND_MUSIC_GAIN;
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
        const adjusted = Math.min(skipTrimmedRanges(trimRanges, clamped), durationRef.current);
        pausedAtSecondsRef.current = adjusted;
        drawFrameAt(adjusted);
        onTimeUpdate?.(adjusted);
      }
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
  const clipsKey = clips.map((clip) => `${clip.assetId}:${clip.url}`).join(",");
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

      const loadedImages: HTMLImageElement[][] = [];
      const loadedFrameRates: number[] = [];
      const loadedAudioBuffers: AudioBuffer[] = [];
      const loadedClipMeta: { assetId: string; url: string; durationSeconds: number }[] = [];
      let failureCount = 0;
      let lastFailureMessage = "";

      for (const clip of clips) {
        if (cancelled) return;
        setLoadingStage(clips.length > 1 ? `Loading clip ${loadedClipMeta.length + failureCount + 1} of ${clips.length}…` : "Loading frames & audio…");

        try {
          const duration = await getVideoDuration(clip.url);
          const frameRate = pickPreviewFrameRate(duration, navigator.hardwareConcurrency || 4);
          const [images, audioBuffer] = await Promise.all([
            extractPreviewFrames(clip.url, frameRate).then((frames) => Promise.all(frames.map(loadImage))),
            decodeAudioBuffer(clip.url),
          ]);
          if (cancelled) return;

          loadedImages.push(images);
          loadedFrameRates.push(frameRate);
          loadedAudioBuffers.push(audioBuffer);
          loadedClipMeta.push({ assetId: clip.assetId, url: clip.url, durationSeconds: duration });
        } catch (err) {
          failureCount += 1;
          lastFailureMessage = err instanceof Error ? err.message : "Failed to load this clip";
        }
      }
      if (cancelled) return;

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
        referenceFrameSizeRef.current = { width: firstImage.naturalWidth, height: firstImage.naturalHeight };
        onFrameDimensions?.({ width: firstImage.naturalWidth, height: firstImage.naturalHeight });
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
    <div className="flex h-full w-full items-center justify-center gap-1 p-2">
      <div className="relative flex h-full max-w-full items-center justify-center overflow-hidden rounded-md bg-black">
        {/* No explicit sizing beyond h-full/max-w-full -- the canvas's own
            width/height attributes (set in drawFrameAt to the fixed
            reference-resolution crop size) already give it the right
            intrinsic aspect ratio, the same way an <img> would. */}
        <canvas ref={canvasRef} className="h-full max-h-full w-auto max-w-full" />
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
          controls rather than generic form buttons -- stacked vertically
          beside the video instead of below it, so the video keeps the
          full height. */}
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
            className={
              "shrink-0 rounded-full p-2 hover:bg-accent/10 " + (isLooping ? "text-accent" : "text-muted")
            }
          >
            <LoopIcon className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
});
