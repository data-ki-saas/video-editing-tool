"use client";

/**
 * Preview player for a video asset -- playback only, no crop editing here
 * (that lives entirely on FrameStrip's timeline now; see its module
 * comment). This player renders the actual CROPPED result: each frame is
 * drawn by sampling only the region CropRect/ZoomEffect say should be kept
 * at that instant and scaling it to fill the canvas, so what's shown is
 * "the final outcome of the work done in the timeline," not the full
 * uncropped frame with a guide drawn over it.
 *
 * Does NOT rely on the browser's native <video> element during playback --
 * a rough approximation of the final render while the user is editing, not
 * a frame-perfect one. Once mounted for a given asset, it: (1) extracts a
 * capped, device/duration-adapted set of frames (see lib/video/video_math.ts's
 * pickPreviewFrameRate and lib/video/video.ts's extractPreviewFrames), (2)
 * decodes the audio track (lib/video/audio.ts's decodeAudioBuffer) -- and
 * from then on, plays both back from a single AudioContext clock, never
 * touching the original video file again. The original video is only ever
 * a source to derive these from, not something played directly.
 *
 * Frame selection during playback is pure math (video_math.ts's
 * frameIndexAtTime) driven by AudioContext.currentTime -- there's no
 * listening to a hidden <video>'s timeupdate/seeked events, and no
 * per-frame syncing logic at all.
 *
 * Exposes an imperative `seekTo` (via ref) so the Playground's frame-strip
 * timeline can scrub this player, and reports playback position upward via
 * `onTimeUpdate` every tick so that timeline can draw a moving playhead --
 * see ThreePaneEditor for how the two are wired together.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Asset } from "@/lib/api";
import { extractPreviewFrames, getVideoDuration } from "@/lib/video/video";
import { decodeAudioBuffer } from "@/lib/video/audio";
import {
  frameIndexAtTime,
  pickPreviewFrameRate,
  computeEffectiveCropRect,
  computeEffectiveFlip,
  skipTrimmedRanges,
  findActiveOverlays,
  FULL_FRAME_CROP_RECT,
  type CropRect,
  type OverlayImage,
  type TrimRange,
  type ZoomEffect,
} from "@/lib/video/video_math";
import { ReelLoader } from "@/components/ReelLoader";
import { PlayIcon, PauseIcon, LoopIcon } from "./icons/PlayerIcons";

export interface CanvasPlayerHandle {
  seekTo(seconds: number): void;
}

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
    asset: Asset;
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
    assetUrlById: Record<string, string>;
    onFrameDimensions?: (dimensions: { width: number; height: number }) => void;
    onTimeUpdate?: (seconds: number) => void;
  }
>(function CanvasPlayer(
  {
    asset,
    baseCropRect,
    zoomEffects,
    liveCropRectOverride = null,
    flipHorizontalToggles,
    flipVerticalToggles,
    trimRanges,
    overlayImages,
    assetUrlById,
    onFrameDimensions,
    onTimeUpdate,
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imagesRef = useRef<HTMLImageElement[]>([]);
  const frameRateRef = useRef(0);
  const durationRef = useRef(0);
  // Loaded overlay images, keyed by assetId -- populated asynchronously
  // (see the loading effect below), so drawFrameAt just skips an overlay
  // whose image hasn't resolved yet rather than waiting on it.
  const overlayImagesRef = useRef<Record<string, HTMLImageElement>>({});

  const audioContextRef = useRef<AudioContext | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
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
  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(false);

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
  }

  /** Draws the frame at `elapsedSeconds`, sampling only the region the
   * current crop/zoom (or a live in-progress drag override) says to keep,
   * scaled to fill the canvas -- this IS the crop, not a guide over an
   * uncropped frame. Canvas width/height track the cropped region's own
   * pixel size, so there's no extra unnecessary scale step beyond that. */
  function drawFrameAt(elapsedSeconds: number) {
    const canvas = canvasRef.current;
    const images = imagesRef.current;
    if (!canvas || images.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const frameIndex = frameIndexAtTime(elapsedSeconds, frameRateRef.current, images.length);
    const image = images[frameIndex];

    const crop = liveCropRectOverride ?? (baseCropRect ? computeEffectiveCropRect(baseCropRect, zoomEffects, elapsedSeconds) : FULL_FRAME_CROP_RECT);
    const sx = crop.x * image.naturalWidth;
    const sy = crop.y * image.naturalHeight;
    const sWidth = crop.width * image.naturalWidth;
    const sHeight = crop.height * image.naturalHeight;

    const targetWidth = Math.max(1, Math.round(sWidth));
    const targetHeight = Math.max(1, Math.round(sHeight));
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
    if (!audioContextRef.current) audioContextRef.current = new AudioContext();
    const audioContext = audioContextRef.current;

    const adjustedOffsetSeconds = Math.min(skipTrimmedRanges(trimRanges, offsetSeconds), durationRef.current);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    source.start(0, adjustedOffsetSeconds);
    sourceNodeRef.current = source;
    playStartedAtCtxTimeRef.current = audioContext.currentTime;
    pausedAtSecondsRef.current = adjustedOffsetSeconds;

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

  // Extracts this asset's preview frames + decodes its audio once per
  // asset -- see the module comment above for why nothing after this
  // effect touches the original video file again.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadingStage("Loading video…");
    setIsReady(false);
    setError(null);
    setIsPlaying(false);
    imagesRef.current = [];
    audioBufferRef.current = null;
    pausedAtSecondsRef.current = 0;
    onTimeUpdate?.(0);

    async function load() {
      const duration = await getVideoDuration(asset.url);
      const frameRate = pickPreviewFrameRate(duration, navigator.hardwareConcurrency || 4);
      frameRateRef.current = frameRate;
      durationRef.current = duration;

      setLoadingStage("Loading frames & audio…");
      const [images, audioBuffer] = await Promise.all([
        extractPreviewFrames(asset.url, frameRate).then((frames) => Promise.all(frames.map(loadImage))),
        decodeAudioBuffer(asset.url),
      ]);

      if (cancelled) return;
      imagesRef.current = images;
      audioBufferRef.current = audioBuffer;
      onFrameDimensions?.({ width: images[0].naturalWidth, height: images[0].naturalHeight });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onTimeUpdate/onFrameDimensions are stable setters from the parent, not worth re-running this for
  }, [asset.url]);

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
            width/height attributes (set in drawFrameAt to the cropped
            region's pixel size) already give it the right intrinsic aspect
            ratio, the same way an <img> would. */}
        <canvas ref={canvasRef} className="h-full max-h-full w-auto max-w-full" />
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <ReelLoader stage={loadingStage} className="text-white" />
          </div>
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
