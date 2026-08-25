"use client";

/**
 * The free/local render pipeline -- takes the same edit state the
 * Creatomate compiler (lib/timeline/compileCreatomateTimeline.ts) turns
 * into cloud-render JSON, and instead renders it entirely in this tab via
 * Mediabunny (a WebCodecs wrapper) with zero network calls. Deliberately
 * reuses CanvasPlayer.tsx's exact per-frame compositing steps (crop/zoom,
 * flip, overlays, text templates) and video_math.ts's segment-splitting
 * math (buildRenderSegments) -- this file is mostly "run that same math
 * offline against real seeked <video> frames instead of a live preview
 * clock," not a new compositor.
 *
 * Video overlays (a second video asset on its own rail -- see
 * video_math.ts's VideoOverlayClip) are composited the same way CanvasPlayer
 * does it, just sourced from a real seeked <video> per output frame instead
 * of pre-extracted preview frames -- see exportVideoLocally's own
 * videoOverlayElementsByAssetId loading and the overlay-drawing block inside
 * its main frame loop. Overlay audio
 * (audioBalance > 0) and the resulting main-track ducking are mixed into
 * buildMixedAudioBuffer's offline graph the same way CanvasPlayer schedules
 * them live, just translated from the overlay's ORIGINAL-timeline window
 * into its OUTPUT-timeline equivalent(s) via mapSourceRangeToOutputRanges,
 * since a trim can split one window into two non-adjacent output ranges.
 *
 * Deliberately NOT attempted here (see the plan this shipped from):
 * WebGL/worker/texture-pool architecture, frame-perfect VideoDecoder
 * demuxing, or auto-captions (transcriptCaption needs Creatomate's
 * server-side speech transcription -- callers must keep the free-render
 * button disabled whenever selections.transcriptCaption is set).
 */
import {
  Output,
  Mp4OutputFormat,
  WebMOutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
  Quality,
  canEncodeVideo,
  canEncodeAudio,
  getFirstEncodableVideoCodec,
  type OutputFormat,
  type VideoCodec,
  type AudioCodec,
} from "mediabunny";
import { loadVideoElement, seekVideoTo, drawImageFlipped } from "@/lib/video/video";
import { decodeAudioBuffer, concatenateAudioBuffers } from "@/lib/video/audio";
import {
  buildRenderSegments,
  computeEffectiveCropRect,
  computeEffectiveFlip,
  computeProgress,
  findActiveOverlays,
  findActiveTextOverlays,
  findActiveExclusiveOverlay,
  findActivePictureInPictureOverlays,
  computeOverlayRects,
  computeCoverFitSourceRect,
  computeMainAudioGainBreakpoints,
  mapSourceRangeToOutputRanges,
  totalSequenceDuration,
  AUDIO_TRANSITION_RAMP_SECONDS,
  DEFAULT_OVERLAY_FRAMING,
  FULL_FRAME_CROP_RECT,
  type RenderSegment,
  type SequenceClipInfo,
  type VideoOverlayClip,
} from "@/lib/video/video_math";
import { getTextTemplateRenderer } from "@/lib/video/textTemplates";
import type { EditSelectionsSnapshot } from "@/lib/projects";

const OUTPUT_FPS = 30;
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const KEY_FRAME_INTERVAL_SECONDS = 3;

export interface LocalRenderInput {
  selections: EditSelectionsSnapshot;
  sequenceClips: SequenceClipInfo[];
  backgroundClips: SequenceClipInfo[];
  /** assetId -> presigned R2 URL, for resolving overlay images (see ThreePaneEditor's own assetUrlById). */
  assetUrlById: Record<string, string>;
  // Flat 0..1 multipliers, same values CanvasPlayer's live preview mixes
  // with (see that file's own props doc) -- kept in sync here so a local
  // export never diverges from what the preview actually sounded like.
  mainAudioVolume: number;
  backgroundVolume: number;
  outputWidth: number;
  outputHeight: number;
}

export interface LocalRenderProgress {
  framesDone: number;
  totalFrames: number;
}

export interface LocalRenderResult {
  blob: Blob;
  mimeType: string;
  /** Non-fatal problems from this render (e.g. an overlay image that
   * couldn't be loaded, so it's silently absent from the output) --
   * surfaced in LocalRenderPopup rather than only logged to the console, so
   * a partially-wrong render is diagnosable without opening devtools. */
  warnings: string[];
}

/** Loads an overlay image via fetch()+blob URL rather than `<img
 * crossOrigin="anonymous">` directly. Both need a real CORS response to
 * avoid tainting the canvas (the encoder reads pixels back every frame,
 * unlike CanvasPlayer's own loadImage, which only ever displays the image
 * and never reads it back) -- but every other place in this app loads the
 * SAME asset URL with no crossOrigin attribute at all (AssetGallery's
 * thumbnail, OverlayTrack, CanvasPlayer's preview). Requesting that exact
 * URL a second time with crossOrigin set can silently fail against an
 * already-cached non-CORS response for it. Fetching it ourselves always
 * performs a real CORS-mode network request, and the resulting blob: URL is
 * inherently origin-clean for canvas reads regardless of crossOrigin at
 * all, sidestepping the whole cache-interaction question. The blob URL is
 * tracked by the caller and revoked once the export finishes. */
async function loadOverlayImage(url: string): Promise<{ image: HTMLImageElement; blobUrl: string }> {
  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) throw new Error(`Could not fetch overlay image (HTTP ${response.status})`);
  const blobUrl = URL.createObjectURL(await response.blob());

  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode overlay image for export"));
    img.src = blobUrl;
  });
  return { image, blobUrl };
}

/** Picks the best output container/codec combo this browser can actually
 * encode, in order of preference: H.264+AAC in MP4 (broadest playback
 * compatibility) -> a WebM codec (VP9/AV1/VP8) + Opus (Opus-in-MP4 has poor
 * real-world playback support, so the whole container switches, not just
 * the audio codec) -> silent H.264 MP4 as a last resort. Throws only if the
 * browser can't encode video at all, which the free-render button's own
 * support check (isLocalRenderSupported.ts) should have already ruled out. */
async function pickOutputConfig(
  width: number,
  height: number
): Promise<{ format: OutputFormat; mimeType: string; videoCodec: VideoCodec; audioCodec: AudioCodec | null }> {
  const audioProbeOptions = { numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE };

  const canH264 = await canEncodeVideo("avc", { width, height });
  if (canH264 && (await canEncodeAudio("aac", audioProbeOptions))) {
    return { format: new Mp4OutputFormat({ fastStart: "in-memory" }), mimeType: "video/mp4", videoCodec: "avc", audioCodec: "aac" };
  }

  const webmVideoCodec = await getFirstEncodableVideoCodec(["vp9", "av1", "vp8"], { width, height });
  if (webmVideoCodec && (await canEncodeAudio("opus", audioProbeOptions))) {
    return { format: new WebMOutputFormat(), mimeType: "video/webm", videoCodec: webmVideoCodec, audioCodec: "opus" };
  }

  if (canH264) {
    return { format: new Mp4OutputFormat({ fastStart: "in-memory" }), mimeType: "video/mp4", videoCodec: "avc", audioCodec: null };
  }

  throw new Error("This browser can't encode video locally -- Edge Render needs a Chromium browser (Chrome or Microsoft Edge).");
}

function findSegmentAtOutputTime(segments: RenderSegment[], outputTimeSeconds: number): RenderSegment | null {
  for (const segment of segments) {
    if (outputTimeSeconds >= segment.outputStartSeconds && outputTimeSeconds < segment.outputStartSeconds + segment.durationSeconds) {
      return segment;
    }
  }
  // Rounding at the very last frame can land a hair past the last segment's
  // end -- clamp to it instead of silently dropping the final frame.
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

/** Builds the whole render's final mixed audio (main sequence audio, cut the
 * same way the video is, plus a looping background track under it, plus any
 * video overlay's own audio and the main-track ducking it causes) as one
 * AudioBuffer via OfflineAudioContext -- mirrors CanvasPlayer's own preview
 * mixing (same mainAudioVolume/backgroundVolume/ducking), but rendered once,
 * offline, instead of played live. Clips whose audio fails to decode are
 * skipped (silence for their segments) rather than failing the whole
 * export, same policy as CanvasPlayer's own sequence loading. Returns any
 * non-fatal warnings alongside the buffer, for the caller to fold into its
 * own LocalRenderResult.warnings. */
async function buildMixedAudioBuffer(
  segments: RenderSegment[],
  sequenceClips: SequenceClipInfo[],
  backgroundClips: SequenceClipInfo[],
  videoOverlays: VideoOverlayClip[],
  assetUrlById: Record<string, string>,
  sourceTotalDurationSeconds: number,
  totalDurationSeconds: number,
  mainAudioVolume: number,
  backgroundVolume: number
): Promise<{ buffer: AudioBuffer; warnings: string[] }> {
  const warnings: string[] = [];
  const totalSamples = Math.max(1, Math.round(totalDurationSeconds * AUDIO_SAMPLE_RATE));
  const offlineContext = new OfflineAudioContext(AUDIO_CHANNELS, totalSamples, AUDIO_SAMPLE_RATE);

  const decodedByAssetId = new Map<string, AudioBuffer>();
  for (const clip of sequenceClips) {
    // An image clip has no audio track at all -- skip the (guaranteed to
    // fail) decode attempt rather than relying on the catch below.
    if (clip.kind === "image" || decodedByAssetId.has(clip.assetId)) continue;
    try {
      decodedByAssetId.set(clip.assetId, await decodeAudioBuffer(clip.url));
    } catch {
      // Skipped -- this clip's segments will just be silent.
    }
  }

  const mainGainNode = offlineContext.createGain();
  mainGainNode.connect(offlineContext.destination);

  // Ducking automation for the main track -- computed against the ORIGINAL
  // (pre-trim) sequence timeline (same convention as VideoOverlayClip's own
  // start/end times), then each breakpoint interval is translated into its
  // OUTPUT-time equivalent(s) via mapSourceRangeToOutputRanges, since a trim
  // can split one interval into two non-adjacent output ranges. Unlike
  // CanvasPlayer (which resumes from an arbitrary live offset), this offline
  // render always starts at output time 0, so every event schedules against
  // an absolute output time with no resume-offset bookkeeping needed.
  const breakpoints = computeMainAudioGainBreakpoints(videoOverlays, sourceTotalDurationSeconds);
  const outputGainEvents: { outputStartSeconds: number; gain: number }[] = [];
  for (let i = 0; i < breakpoints.length; i++) {
    const rangeStartSeconds = breakpoints[i].timeSeconds;
    const rangeEndSeconds = i + 1 < breakpoints.length ? breakpoints[i + 1].timeSeconds : sourceTotalDurationSeconds;
    if (rangeEndSeconds <= rangeStartSeconds) continue;
    for (const outputRange of mapSourceRangeToOutputRanges(segments, rangeStartSeconds, rangeEndSeconds)) {
      outputGainEvents.push({ outputStartSeconds: outputRange.outputStartSeconds, gain: breakpoints[i].gain * mainAudioVolume });
    }
  }
  outputGainEvents.sort((a, b) => a.outputStartSeconds - b.outputStartSeconds);

  let previousGain = mainAudioVolume;
  mainGainNode.gain.setValueAtTime(previousGain, 0);
  for (const event of outputGainEvents) {
    mainGainNode.gain.setValueAtTime(previousGain, event.outputStartSeconds);
    mainGainNode.gain.linearRampToValueAtTime(event.gain, event.outputStartSeconds + AUDIO_TRANSITION_RAMP_SECONDS);
    previousGain = event.gain;
  }

  for (const segment of segments) {
    const buffer = decodedByAssetId.get(segment.assetId);
    if (!buffer) continue;
    const source = offlineContext.createBufferSource();
    source.buffer = buffer;
    source.connect(mainGainNode);
    source.start(segment.outputStartSeconds, segment.clipLocalStartSeconds, segment.durationSeconds);
  }

  // One AudioBufferSourceNode per (overlay, output-time chunk) that wants
  // some of its own audio (audioBalance > 0) -- mirrors CanvasPlayer's own
  // per-overlay scheduling (fade in/out, loop = true), just keyed to
  // absolute output time instead of a live resume offset. An overlay whose
  // window is split by a trim gets one source per surviving chunk.
  const overlayAudioAssetIds = Array.from(new Set(videoOverlays.filter((o) => o.audioBalance > 0).map((o) => o.assetId)));
  const overlayAudioByAssetId = new Map<string, AudioBuffer>();
  for (const assetId of overlayAudioAssetIds) {
    const url = assetUrlById[assetId];
    if (!url) continue;
    try {
      overlayAudioByAssetId.set(assetId, await decodeAudioBuffer(url));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(`A video overlay's own audio (assetId ${assetId}) couldn't be decoded for this render: ${reason}`);
    }
  }

  for (const overlay of videoOverlays) {
    if (overlay.audioBalance <= 0) continue;
    const overlayBuffer = overlayAudioByAssetId.get(overlay.assetId);
    if (!overlayBuffer || overlayBuffer.duration <= 0) continue;

    for (const outputRange of mapSourceRangeToOutputRanges(segments, overlay.startTimeSeconds, overlay.endTimeSeconds)) {
      const windowDurationSeconds = outputRange.outputEndSeconds - outputRange.outputStartSeconds;
      if (windowDurationSeconds <= 0) continue;
      const startTimeSeconds = outputRange.outputStartSeconds;
      const elapsedIntoWindowSeconds = outputRange.sourceOverlapStartSeconds - overlay.startTimeSeconds;
      const fadeOutStartSeconds = Math.max(
        startTimeSeconds + AUDIO_TRANSITION_RAMP_SECONDS,
        startTimeSeconds + windowDurationSeconds - AUDIO_TRANSITION_RAMP_SECONDS
      );

      const overlaySource = offlineContext.createBufferSource();
      overlaySource.buffer = overlayBuffer;
      overlaySource.loop = true;
      const overlayGainNode = offlineContext.createGain();
      overlayGainNode.gain.setValueAtTime(0, startTimeSeconds);
      overlayGainNode.gain.linearRampToValueAtTime(overlay.audioBalance, startTimeSeconds + AUDIO_TRANSITION_RAMP_SECONDS);
      overlayGainNode.gain.setValueAtTime(overlay.audioBalance, fadeOutStartSeconds);
      overlayGainNode.gain.linearRampToValueAtTime(0, startTimeSeconds + windowDurationSeconds);
      overlaySource.connect(overlayGainNode).connect(offlineContext.destination);
      overlaySource.start(startTimeSeconds, elapsedIntoWindowSeconds % overlayBuffer.duration, windowDurationSeconds);
    }
  }

  if (backgroundClips.length > 0) {
    const decodedBackground: AudioBuffer[] = [];
    for (const clip of backgroundClips) {
      try {
        decodedBackground.push(await decodeAudioBuffer(clip.url));
      } catch {
        // Skipped -- same "one bad track shouldn't block the rest" policy as CanvasPlayer.
      }
    }
    if (decodedBackground.length > 0) {
      const concatenated = concatenateAudioBuffers(offlineContext, decodedBackground);
      const backgroundSource = offlineContext.createBufferSource();
      backgroundSource.buffer = concatenated;
      backgroundSource.loop = true;
      const gainNode = offlineContext.createGain();
      gainNode.gain.value = backgroundVolume;
      backgroundSource.connect(gainNode).connect(offlineContext.destination);
      backgroundSource.start(0);
    }
  }

  return { buffer: await offlineContext.startRendering(), warnings };
}

export async function exportVideoLocally(
  input: LocalRenderInput,
  onProgress?: (progress: LocalRenderProgress) => void
): Promise<LocalRenderResult> {
  const { selections, sequenceClips, backgroundClips, assetUrlById, mainAudioVolume, backgroundVolume, outputWidth, outputHeight } = input;
  if (sequenceClips.length === 0) throw new Error("Nothing to render -- add a video to the sequence first.");

  const baseCropRect = selections.cropRect ?? FULL_FRAME_CROP_RECT;
  const segments = buildRenderSegments(sequenceClips, selections.trimRanges);
  const totalDurationSeconds = segments.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  const totalFrames = Math.max(1, Math.round(totalDurationSeconds * OUTPUT_FPS));

  const { format, mimeType, videoCodec, audioCodec } = await pickOutputConfig(outputWidth, outputHeight);

  const videoElementsByAssetId = new Map<string, HTMLVideoElement>();
  // A still image's own clip frame -- distinct from overlayImagesByAssetId
  // below (picture-in-picture layers), this is the BASE clip's own frame,
  // held for its whole segment instead of seeked per-frame like a video.
  const imageClipElementsByAssetId = new Map<string, HTMLImageElement>();
  const overlayImagesByAssetId = new Map<string, HTMLImageElement>();
  // A video overlay's own source, keyed by assetId (shared across multiple
  // overlay clips reusing the same asset) -- a real seekable <video>, same
  // as videoElementsByAssetId above, so each output frame samples an actual
  // decoded frame rather than a pre-extracted preview one.
  const videoOverlayElementsByAssetId = new Map<string, HTMLVideoElement>();
  const overlayBlobUrls: string[] = [];
  const warnings: string[] = [];

  try {
    for (const clip of sequenceClips) {
      if (clip.kind === "image") {
        if (imageClipElementsByAssetId.has(clip.assetId)) continue;
        const { image, blobUrl } = await loadOverlayImage(clip.url);
        imageClipElementsByAssetId.set(clip.assetId, image);
        overlayBlobUrls.push(blobUrl);
        continue;
      }
      if (videoElementsByAssetId.has(clip.assetId)) continue;
      videoElementsByAssetId.set(clip.assetId, await loadVideoElement(clip.url, "auto"));
    }

    const overlayAssetIds = new Set(selections.overlayImages.map((overlay) => overlay.assetId));
    for (const assetId of overlayAssetIds) {
      const url = assetUrlById[assetId];
      if (!url) {
        const message = `Overlay image (assetId ${assetId}) has no resolved URL -- it won't appear in this render.`;
        console.warn(`Edge Render: ${message}`);
        warnings.push(message);
        continue;
      }
      try {
        const { image, blobUrl } = await loadOverlayImage(url);
        overlayImagesByAssetId.set(assetId, image);
        overlayBlobUrls.push(blobUrl);
      } catch (err) {
        // Skipped -- matches CanvasPlayer's "one broken overlay shouldn't block the rest" policy.
        // Logged AND surfaced as a render warning (rather than fully silent)
        // so a missing overlay in the output is diagnosable without opening
        // devtools.
        const reason = err instanceof Error ? err.message : String(err);
        const message = `Overlay image (assetId ${assetId}) couldn't be loaded for this render: ${reason}`;
        console.warn(`Edge Render: ${message}`);
        warnings.push(message);
      }
    }

    const videoOverlayAssetIds = new Set(selections.videoOverlays.map((overlay) => overlay.assetId));
    for (const assetId of videoOverlayAssetIds) {
      const url = assetUrlById[assetId];
      if (!url) {
        const message = `A video overlay (assetId ${assetId}) has no resolved URL -- it won't appear in this render.`;
        console.warn(`Edge Render: ${message}`);
        warnings.push(message);
        continue;
      }
      try {
        videoOverlayElementsByAssetId.set(assetId, await loadVideoElement(url, "auto"));
      } catch (err) {
        // Skipped -- matches CanvasPlayer's "one broken overlay shouldn't block the rest" policy.
        const reason = err instanceof Error ? err.message : String(err);
        const message = `A video overlay (assetId ${assetId}) couldn't be loaded for this render: ${reason}`;
        console.warn(`Edge Render: ${message}`);
        warnings.push(message);
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");

    const target = new BufferTarget();
    const output = new Output({ format, target });

    const videoSource = new CanvasSource(canvas, {
      codec: videoCodec,
      quality: new Quality("high"),
      keyFrameInterval: KEY_FRAME_INTERVAL_SECONDS,
    });
    output.addVideoTrack(videoSource);

    const audioSource = audioCodec ? new AudioBufferSource({ codec: audioCodec, quality: new Quality("high") }) : null;
    if (audioSource) output.addAudioTrack(audioSource);

    await output.start();

    for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
      const outputTimeSeconds = frameIndex / OUTPUT_FPS;
      const segment = findSegmentAtOutputTime(segments, outputTimeSeconds);
      if (!segment) break;

      const sourceTimeSeconds = segment.sourceStartSeconds + (outputTimeSeconds - segment.outputStartSeconds);
      const localSeconds = segment.clipLocalStartSeconds + (outputTimeSeconds - segment.outputStartSeconds);
      const source: HTMLVideoElement | HTMLImageElement | null =
        segment.kind === "image"
          ? (imageClipElementsByAssetId.get(segment.assetId) ?? null)
          : (videoElementsByAssetId.get(segment.assetId) ?? null);

      if (source instanceof HTMLVideoElement) {
        await seekVideoTo(source, localSeconds);
      }

      // At most one of these is active at a time (Full-Screen and
      // Split-Screen claim exclusivity over each other) -- see
      // findActiveExclusiveOverlay's own doc comment. `baseRect: null` means
      // Full-Screen is active, so the base clip is skipped entirely below
      // (the overlay's own draw, further down, fully covers the canvas).
      const activeExclusiveOverlay = findActiveExclusiveOverlay(selections.videoOverlays, sourceTimeSeconds);
      const { baseRect, overlayRect } = activeExclusiveOverlay
        ? computeOverlayRects(activeExclusiveOverlay.layout)
        : { baseRect: FULL_FRAME_CROP_RECT, overlayRect: null };

      if (source) {
        const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
        const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
        const crop = computeEffectiveCropRect(baseCropRect, selections.zoomEffects, sourceTimeSeconds);
        const sx = crop.x * sourceWidth;
        const sy = crop.y * sourceHeight;
        const sWidth = crop.width * sourceWidth;
        const sHeight = crop.height * sourceHeight;

        const flipHorizontal = computeEffectiveFlip(selections.flipHorizontalToggles, sourceTimeSeconds);
        const flipVertical = computeEffectiveFlip(selections.flipVerticalToggles, sourceTimeSeconds);

        ctx.save();
        ctx.translate(flipHorizontal ? canvas.width : 0, flipVertical ? canvas.height : 0);
        ctx.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
        if (baseRect && activeExclusiveOverlay?.layout.type === "split-screen") {
          // A Split-Screen half's own box generally has a DIFFERENT aspect
          // ratio than `crop` -- cover-fit the already-cropped region into
          // it using this window's own baseFraming pan, exactly mirroring
          // CanvasPlayer's identical branch.
          const baseDestX = baseRect.x * canvas.width;
          const baseDestY = baseRect.y * canvas.height;
          const baseDestWidth = baseRect.width * canvas.width;
          const baseDestHeight = baseRect.height * canvas.height;
          const { panX, panY, flipHorizontal: baseFlipH, flipVertical: baseFlipV } =
            activeExclusiveOverlay.layout.baseFraming ?? DEFAULT_OVERLAY_FRAMING;
          const { sx: bsx, sy: bsy, sWidth: bsw, sHeight: bsh } = computeCoverFitSourceRect(
            sWidth, sHeight, baseDestWidth, baseDestHeight, panX, panY
          );
          drawImageFlipped(ctx, source, sx + bsx, sy + bsy, bsw, bsh, baseDestX, baseDestY, baseDestWidth, baseDestHeight, baseFlipH, baseFlipV);
        } else if (baseRect) {
          // null only for an active Full-Screen overlay -- its own draw
          // below fully covers the canvas regardless, so skipping this is a
          // pure optimization, never load-bearing for correctness.
          ctx.drawImage(
            source, sx, sy, sWidth, sHeight,
            baseRect.x * canvas.width, baseRect.y * canvas.height, baseRect.width * canvas.width, baseRect.height * canvas.height
          );
        }
        ctx.restore();
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }

      // Composited AFTER the flip transform above is undone -- a video
      // overlay is independent of the base clip's own flip state.
      if (activeExclusiveOverlay && overlayRect) {
        const overlayVideo = videoOverlayElementsByAssetId.get(activeExclusiveOverlay.assetId);
        if (overlayVideo) {
          const localOffsetSeconds = activeExclusiveOverlay.sourceStartSeconds + (sourceTimeSeconds - activeExclusiveOverlay.startTimeSeconds);
          // Loops back to the start once the window runs past one
          // play-through of the source, same as CanvasPlayer -- frameIndexAtTime's
          // seek equivalent (seekVideoTo below) would otherwise just clamp
          // to the end and freeze there.
          const loopedOffsetSeconds = overlayVideo.duration > 0 ? localOffsetSeconds % overlayVideo.duration : localOffsetSeconds;
          await seekVideoTo(overlayVideo, loopedOffsetSeconds);
          const destX = overlayRect.x * canvas.width;
          const destY = overlayRect.y * canvas.height;
          const destWidth = overlayRect.width * canvas.width;
          const destHeight = overlayRect.height * canvas.height;
          const { sx: osx, sy: osy, sWidth: osw, sHeight: osh } = computeCoverFitSourceRect(
            overlayVideo.videoWidth, overlayVideo.videoHeight, destWidth, destHeight,
            activeExclusiveOverlay.framing.panX, activeExclusiveOverlay.framing.panY
          );
          drawImageFlipped(
            ctx, overlayVideo, osx, osy, osw, osh, destX, destY, destWidth, destHeight,
            activeExclusiveOverlay.framing.flipHorizontal, activeExclusiveOverlay.framing.flipVertical
          );
        }
      }

      // Picture-in-Picture overlays float on top of whatever's showing --
      // unlike the exclusive layouts, any number can be active at once.
      for (const pip of findActivePictureInPictureOverlays(selections.videoOverlays, sourceTimeSeconds)) {
        if (pip.layout.type !== "picture-in-picture") continue; // narrows the type for pip.layout.rect below
        const overlayVideo = videoOverlayElementsByAssetId.get(pip.assetId);
        if (!overlayVideo) continue;
        const localOffsetSeconds = pip.sourceStartSeconds + (sourceTimeSeconds - pip.startTimeSeconds);
        const loopedOffsetSeconds = overlayVideo.duration > 0 ? localOffsetSeconds % overlayVideo.duration : localOffsetSeconds;
        await seekVideoTo(overlayVideo, loopedOffsetSeconds);
        const destX = pip.layout.rect.x * canvas.width;
        const destY = pip.layout.rect.y * canvas.height;
        const destWidth = pip.layout.rect.width * canvas.width;
        const destHeight = pip.layout.rect.height * canvas.height;
        const { sx: psx, sy: psy, sWidth: psw, sHeight: psh } = computeCoverFitSourceRect(
          overlayVideo.videoWidth, overlayVideo.videoHeight, destWidth, destHeight, pip.framing.panX, pip.framing.panY
        );
        drawImageFlipped(ctx, overlayVideo, psx, psy, psw, psh, destX, destY, destWidth, destHeight, pip.framing.flipHorizontal, pip.framing.flipVertical);
      }

      for (const overlay of findActiveOverlays(selections.overlayImages, sourceTimeSeconds)) {
        const overlayImage = overlayImagesByAssetId.get(overlay.assetId);
        if (!overlayImage) continue;
        ctx.drawImage(
          overlayImage,
          overlay.rect.x * canvas.width,
          overlay.rect.y * canvas.height,
          overlay.rect.width * canvas.width,
          overlay.rect.height * canvas.height
        );
      }

      for (const overlay of findActiveTextOverlays(selections.textOverlays, sourceTimeSeconds)) {
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
          progress: computeProgress(overlay.startTimeSeconds, overlay.endTimeSeconds, sourceTimeSeconds),
        });
      }

      // CanvasSource.add resolves once Mediabunny/the encoder is ready for
      // more -- awaiting it is the backpressure mechanism, no manual
      // encodeQueueSize polling needed.
      await videoSource.add(outputTimeSeconds, 1 / OUTPUT_FPS);
      onProgress?.({ framesDone: frameIndex + 1, totalFrames });
    }

    if (audioSource) {
      const { buffer: mixedAudio, warnings: audioWarnings } = await buildMixedAudioBuffer(
        segments,
        sequenceClips,
        backgroundClips,
        selections.videoOverlays,
        assetUrlById,
        totalSequenceDuration(sequenceClips),
        totalDurationSeconds,
        mainAudioVolume,
        backgroundVolume
      );
      warnings.push(...audioWarnings);
      await audioSource.add(mixedAudio);
    }

    await output.finalize();

    if (!target.buffer) throw new Error("Local render finished with no output data");
    return { blob: new Blob([target.buffer], { type: mimeType }), mimeType, warnings };
  } finally {
    for (const video of videoElementsByAssetId.values()) {
      video.removeAttribute("src");
      video.load();
    }
    for (const video of videoOverlayElementsByAssetId.values()) {
      video.removeAttribute("src");
      video.load();
    }
    for (const blobUrl of overlayBlobUrls) {
      URL.revokeObjectURL(blobUrl);
    }
  }
}
