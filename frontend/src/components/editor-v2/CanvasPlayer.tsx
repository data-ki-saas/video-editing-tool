"use client";

/**
 * Preview player for a video asset that does NOT rely on the browser's
 * native <video> element during playback -- a rough approximation of the
 * final render while the user is editing, not a frame-perfect one. Once
 * mounted for a given asset, it: (1) extracts a capped, device/duration-
 * adapted set of frames (see lib/video/video_math.ts's pickPreviewFrameRate
 * and lib/video/video.ts's extractPreviewFrames), (2) decodes the audio
 * track (lib/video/audio.ts's decodeAudioBuffer) -- and from then on, plays
 * both back from a single AudioContext clock, never touching the original
 * video file again. The original video is only ever a source to derive
 * these from, not something played directly.
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
import { frameIndexAtTime, pickPreviewFrameRate } from "@/lib/video/video_math";

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

export const CanvasPlayer = forwardRef<CanvasPlayerHandle, { asset: Asset; onTimeUpdate?: (seconds: number) => void }>(
  function CanvasPlayer({ asset, onTimeUpdate }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imagesRef = useRef<HTMLImageElement[]>([]);
    const frameRateRef = useRef(0);
    const durationRef = useRef(0);

    const audioContextRef = useRef<AudioContext | null>(null);
    const audioBufferRef = useRef<AudioBuffer | null>(null);
    const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
    const animationFrameIdRef = useRef<number | null>(null);
    // Wall-clock bookkeeping for the AudioContext-driven playback clock:
    // elapsed = pausedAtSeconds while stopped, or
    // pausedAtSeconds + (ctx.currentTime - playStartedAtCtxTime) while playing.
    const pausedAtSecondsRef = useRef(0);
    const playStartedAtCtxTimeRef = useRef(0);

    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isReady, setIsReady] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);

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

    function drawFrameAt(elapsedSeconds: number) {
      const canvas = canvasRef.current;
      const images = imagesRef.current;
      if (!canvas || images.length === 0) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const frameIndex = frameIndexAtTime(elapsedSeconds, frameRateRef.current, images.length);
      const image = images[frameIndex];
      if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
      }
      ctx.drawImage(image, 0, 0);
    }

    function tick() {
      const audioContext = audioContextRef.current;
      if (!audioContext) return;

      const elapsed = pausedAtSecondsRef.current + (audioContext.currentTime - playStartedAtCtxTimeRef.current);
      if (elapsed >= durationRef.current) {
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
     * loop" (a source node can't be paused/resumed in place, only stopped). */
    function resumePlaybackFrom(offsetSeconds: number) {
      const audioBuffer = audioBufferRef.current;
      if (!audioBuffer) return;
      if (!audioContextRef.current) audioContextRef.current = new AudioContext();
      const audioContext = audioContextRef.current;

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);
      source.start(0, offsetSeconds);
      sourceNodeRef.current = source;
      playStartedAtCtxTimeRef.current = audioContext.currentTime;
      pausedAtSecondsRef.current = offsetSeconds;

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

    useImperativeHandle(ref, () => ({
      seekTo(seconds: number) {
        if (!isReady) return;
        const clamped = Math.min(Math.max(seconds, 0), durationRef.current);
        if (isPlaying) {
          stopPlaybackLoop();
          resumePlaybackFrom(clamped);
        } else {
          pausedAtSecondsRef.current = clamped;
          drawFrameAt(clamped);
          onTimeUpdate?.(clamped);
        }
      },
    }));

    // Extracts this asset's preview frames + decodes its audio once per
    // asset -- see the module comment above for why nothing after this
    // effect touches the original video file again.
    useEffect(() => {
      let cancelled = false;
      setIsLoading(true);
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

        const [images, audioBuffer] = await Promise.all([
          extractPreviewFrames(asset.url, frameRate).then((frames) => Promise.all(frames.map(loadImage))),
          decodeAudioBuffer(asset.url),
        ]);

        if (cancelled) return;
        imagesRef.current = images;
        audioBufferRef.current = audioBuffer;
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
      // eslint-disable-next-line react-hooks/exhaustive-deps -- onTimeUpdate is a stable setter from the parent, not worth re-running this for
    }, [asset.url]);

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
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-2">
        <canvas ref={canvasRef} className="max-h-full max-w-full rounded-md" />
        {isLoading && <p className="text-xs text-muted">Preparing preview…</p>}
        {isReady && (
          <button
            type="button"
            onClick={handlePlayPause}
            className="shrink-0 rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-foreground hover:opacity-90"
          >
            {isPlaying ? "Pause" : "Play"}
          </button>
        )}
      </div>
    );
  }
);
