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
import { loadVideoElement, seekVideoTo, drawImageFlipped, drawImageFlippedMasked, drawImageFlippedChromaKeyed } from "@/lib/video/video";
import { Camera3DRenderer, computeCamera3DPoseForZoomEffect, computeCamera3DPoseForOverlay } from "@/lib/video/camera3D";
import { drawAmbientEffect, ambientEffectSeed } from "@/lib/video/ambientEffects";
import { normalizeImageTemplateIds } from "@/lib/video/imageTemplates";
import { DEFAULT_CHROMA_KEY_COLOR, hexToRgb } from "@/lib/video/chromaKey";
import { decodeAudioBuffer, concatenateAudioBuffers } from "@/lib/video/audio";
import {
  buildRenderSegments,
  computeEffectiveCropRect,
  findActiveZoomEffectIndex,
  reprojectCropRect,
  computeEffectiveFlip,
  computeProgress,
  findActiveTextOverlays,
  findActiveTtsOverlays,
  findActiveWordIndex,
  ttsOverlayEndTimeSeconds,
  findActiveExclusiveOverlay,
  findActivePictureInPictureOverlays,
  computeOverlayRects,
  computeCoverFitSourceRect,
  MIN_PICTURE_IN_PICTURE_ZOOM,
  computeAudioMixBreakpoints,
  mapSourceRangeToOutputRanges,
  totalSequenceDuration,
  totalRenderOutputDuration,
  resolveRenderSegmentBlend,
  AUDIO_TRANSITION_RAMP_SECONDS,
  DEFAULT_OVERLAY_FRAMING,
  FULL_FRAME_CROP_RECT,
  computeMaxCoverageCropRect,
  computeContainFitRect,
  type RenderSegment,
  type SequenceClipInfo,
  type TtsOverlay,
  type VideoOverlayClip,
} from "@/lib/video/video_math";
import { getTextTemplateRenderer, drawKaraokeCaption } from "@/lib/video/textTemplates";
import { drawBrandWatermark } from "@/lib/video/brandWatermark";
import { getFilterPresetOption, type FilterPresetId } from "@/lib/video/filterPresets";
import {
  getCanvasFillMode,
  CANVAS_FILL_BLUR_RADIUS_FRACTION,
  DEFAULT_CANVAS_FILL_COLOR,
  DEFAULT_CANVAS_FILL_GRADIENT_COLOR,
} from "@/lib/video/canvasFillPresets";
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
  /** Re-resolves a single asset's presigned URL from the backend (a fresh
   * listAssets(projectId) lookup, see ThreePaneEditor's own
   * handleLocalRenderClick) -- loadOverlayImage below calls this between
   * retry attempts so a URL that's actually gone stale (rather than just
   * hit a one-off network blip) gets a real fix instead of being retried
   * unchanged. Optional so this file has no hard dependency on the API
   * client -- omitting it just falls back to the plain retry-same-URL
   * behavior. */
  refreshAssetUrl?: (assetId: string) => Promise<string | undefined>;
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
const IMAGE_FETCH_RETRY_ATTEMPTS = 3;
const IMAGE_FETCH_RETRY_DELAY_MS = 500;

async function loadOverlayImage(
  url: string,
  opts?: { assetId?: string; refreshUrl?: (assetId: string) => Promise<string | undefined> }
): Promise<{ image: HTMLImageElement; blobUrl: string }> {
  let response: Response | undefined;
  let lastErr: unknown;
  let currentUrl = url;
  // A bare "Failed to fetch" is the browser's generic name for a network
  // request that never got a response at all -- a genuinely expired
  // presigned URL (deterministic, retrying the same URL can't fix it) looks
  // IDENTICAL at this layer to a one-off Wi-Fi/DNS/R2-cold-path blip (not
  // deterministic, a retry fixes it). A couple of quick retries costs
  // nothing when it's really an expiry (still fails, same error surfaces),
  // but resolves the transient case that used to abort the whole render.
  for (let attempt = 1; attempt <= IMAGE_FETCH_RETRY_ATTEMPTS; attempt++) {
    try {
      response = await fetch(currentUrl, { mode: "cors" });
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < IMAGE_FETCH_RETRY_ATTEMPTS) {
        // Re-resolves a FRESH presigned URL before the next attempt when
        // possible -- fixes the genuinely-expired case outright, which
        // retrying the exact same (already-dead) URL after a delay never
        // could. Falls back to the old delay-and-retry-unchanged behavior
        // when no assetId/refresher was supplied.
        const refreshed = opts?.assetId && opts.refreshUrl ? await opts.refreshUrl(opts.assetId).catch(() => undefined) : undefined;
        if (refreshed) currentUrl = refreshed;
        else await new Promise((r) => setTimeout(r, IMAGE_FETCH_RETRY_DELAY_MS));
      }
    }
  }
  if (!response) {
    // R2 omits CORS headers on its own error responses, so the browser
    // reports even a real expired-signature/CORS-policy failure as this
    // same opaque network error rather than exposing the true HTTP status.
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`Network error fetching image asset -- likely an expired URL or R2 connectivity/CORS issue (${reason})`);
  }
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

/** Schedules `gainNode`'s automation across one already trim-mapped OUTPUT
 * sub-range as: a fade in from silence to `nominalGain` scaled by whatever
 * duckScale applies at this sub-range's own SOURCE start, then a plateau at
 * each `breakpoints` crossing WITHIN the sub-range's own source overlap
 * (mapped to its own output-time equivalent via the constant offset this
 * sub-range's own outputStartSeconds/sourceOverlapStartSeconds establish),
 * finishing with a fade-out to 0 at the sub-range's own end. Mirrors
 * CanvasPlayer.tsx's own scheduleDuckedGain, just in OfflineAudioContext/
 * absolute-output-time terms instead of live ctx-relative terms -- see that
 * file's own comment and video_math.ts's sampleAudioMixAt for the mixer
 * spec. Offline export always starts fresh at each sub-range's own start
 * (no "already playing, skip the fade-in" case -- that's a CanvasPlayer-only
 * concern, live resume-from-an-arbitrary-offset has no equivalent here). */
function scheduleDuckedGainOffline(
  gainNode: GainNode,
  nominalGain: number,
  outputRange: { outputStartSeconds: number; outputEndSeconds: number; sourceOverlapStartSeconds: number; sourceOverlapEndSeconds: number },
  breakpoints: { timeSeconds: number; duckScale: number }[]
) {
  const windowDurationSeconds = outputRange.outputEndSeconds - outputRange.outputStartSeconds;
  const startTimeSeconds = outputRange.outputStartSeconds;
  const fadeOutStartSeconds = Math.max(
    startTimeSeconds + AUDIO_TRANSITION_RAMP_SECONDS,
    startTimeSeconds + windowDurationSeconds - AUDIO_TRANSITION_RAMP_SECONDS
  );
  function duckScaleAt(sourceTimeSeconds: number): number {
    let scale = 1;
    for (const bp of breakpoints) {
      if (bp.timeSeconds > sourceTimeSeconds) break;
      scale = bp.duckScale;
    }
    return scale;
  }
  function outputTimeForSource(sourceTimeSeconds: number): number {
    return outputRange.outputStartSeconds + (sourceTimeSeconds - outputRange.sourceOverlapStartSeconds);
  }

  gainNode.gain.setValueAtTime(0, startTimeSeconds);
  let previousGain = nominalGain * duckScaleAt(outputRange.sourceOverlapStartSeconds);
  let previousTimeSeconds = startTimeSeconds + AUDIO_TRANSITION_RAMP_SECONDS;
  gainNode.gain.linearRampToValueAtTime(previousGain, previousTimeSeconds);

  for (const bp of breakpoints) {
    if (bp.timeSeconds <= outputRange.sourceOverlapStartSeconds || bp.timeSeconds >= outputRange.sourceOverlapEndSeconds) continue;
    const rampTimeSeconds = outputTimeForSource(bp.timeSeconds);
    if (rampTimeSeconds <= previousTimeSeconds) continue;
    const target = nominalGain * bp.duckScale;
    gainNode.gain.setValueAtTime(previousGain, rampTimeSeconds);
    gainNode.gain.linearRampToValueAtTime(target, rampTimeSeconds + AUDIO_TRANSITION_RAMP_SECONDS);
    previousGain = target;
    previousTimeSeconds = rampTimeSeconds + AUDIO_TRANSITION_RAMP_SECONDS;
  }
  gainNode.gain.setValueAtTime(previousGain, Math.max(fadeOutStartSeconds, previousTimeSeconds));
  gainNode.gain.linearRampToValueAtTime(0, startTimeSeconds + windowDurationSeconds);
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
  ttsOverlays: TtsOverlay[],
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
  // an absolute output time with no resume-offset bookkeeping needed. This
  // same `breakpoints` list (mainGain AND duckScale together) is reused
  // below by the overlay-audio and TTS-audio blocks for their own ducking --
  // see sampleAudioMixAt's own doc comment for the full mixer spec.
  const breakpoints = computeAudioMixBreakpoints(videoOverlays, ttsOverlays, sourceTotalDurationSeconds);
  const outputGainEvents: { outputStartSeconds: number; gain: number }[] = [];
  for (let i = 0; i < breakpoints.length; i++) {
    const rangeStartSeconds = breakpoints[i].timeSeconds;
    const rangeEndSeconds = i + 1 < breakpoints.length ? breakpoints[i + 1].timeSeconds : sourceTotalDurationSeconds;
    if (rangeEndSeconds <= rangeStartSeconds) continue;
    for (const outputRange of mapSourceRangeToOutputRanges(segments, rangeStartSeconds, rangeEndSeconds)) {
      outputGainEvents.push({ outputStartSeconds: outputRange.outputStartSeconds, gain: breakpoints[i].mainGain * mainAudioVolume });
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

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const buffer = decodedByAssetId.get(segment.assetId);
    if (!buffer) continue;
    const source = offlineContext.createBufferSource();
    source.buffer = buffer;

    // The audio side of a cut-transition -- each segment already gets its
    // OWN source node here (unlike CanvasPlayer's single continuous
    // concatenated buffer), so a per-segment gain node chained ahead of the
    // shared mainGainNode is all a crossfade needs: fades THIS segment's
    // own audio in from silence if a transition plays INTO it
    // (cutTransitionOverlapSeconds), and/or fades it out to silence if the
    // NEXT segment transitions in FROM it -- a clip sandwiched between two
    // transitions gets both. Ducking automation stays on the shared
    // mainGainNode, unaffected, so it still applies on top.
    const incomingOverlapSeconds = segment.cutTransitionOverlapSeconds ?? 0;
    const nextOverlapSeconds = segments[i + 1]?.cutTransitionOverlapSeconds ?? 0;
    if (incomingOverlapSeconds > 0 || nextOverlapSeconds > 0) {
      const transitionGainNode = offlineContext.createGain();
      if (incomingOverlapSeconds > 0) {
        transitionGainNode.gain.setValueAtTime(0, segment.outputStartSeconds);
        transitionGainNode.gain.linearRampToValueAtTime(1, segment.outputStartSeconds + incomingOverlapSeconds);
      }
      if (nextOverlapSeconds > 0) {
        const fadeOutStartSeconds = segment.outputStartSeconds + segment.durationSeconds - nextOverlapSeconds;
        transitionGainNode.gain.setValueAtTime(1, fadeOutStartSeconds);
        transitionGainNode.gain.linearRampToValueAtTime(0, segment.outputStartSeconds + segment.durationSeconds);
      }
      source.connect(transitionGainNode).connect(mainGainNode);
    } else {
      source.connect(mainGainNode);
    }
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

      const overlaySource = offlineContext.createBufferSource();
      overlaySource.buffer = overlayBuffer;
      overlaySource.loop = true;
      const overlayGainNode = offlineContext.createGain();
      // Ducked against any TTS narration (and, unusually, any other
      // overlapping overlay) sharing this window -- see
      // scheduleDuckedGainOffline above and sampleAudioMixAt's own doc
      // comment for the mixer spec.
      scheduleDuckedGainOffline(overlayGainNode, overlay.audioBalance, outputRange, breakpoints);
      overlaySource.connect(overlayGainNode).connect(offlineContext.destination);
      overlaySource.start(startTimeSeconds, elapsedIntoWindowSeconds % overlayBuffer.duration, windowDurationSeconds);
    }
  }

  // One AudioBufferSourceNode per (TTS overlay, output-time chunk) --
  // mirrors CanvasPlayer's own narration scheduling (fade in/out at each
  // window's own edges, single play, never looped -- narration has a real
  // beginning and end, unlike background music or a looping overlay). An
  // overlay whose window is split by a trim gets one source per surviving
  // chunk, same as the video-overlay audio block above. No ducking against
  // the main track/background music here either -- same known, deliberate
  // follow-up CanvasPlayer.tsx's own comment notes.
  const ttsAssetIds = Array.from(new Set(ttsOverlays.map((overlay) => overlay.assetId)));
  const ttsAudioByAssetId = new Map<string, AudioBuffer>();
  for (const assetId of ttsAssetIds) {
    const url = assetUrlById[assetId];
    if (!url) continue;
    try {
      ttsAudioByAssetId.set(assetId, await decodeAudioBuffer(url));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(`A TTS narration overlay's audio (assetId ${assetId}) couldn't be decoded for this render: ${reason}`);
    }
  }

  for (const overlay of ttsOverlays) {
    const ttsBuffer = ttsAudioByAssetId.get(overlay.assetId);
    if (!ttsBuffer || ttsBuffer.duration <= 0) continue;
    const overlayEndSeconds = ttsOverlayEndTimeSeconds(overlay);
    const nominalGain = Math.min(Math.max(overlay.volume, 0), 1);

    for (const outputRange of mapSourceRangeToOutputRanges(segments, overlay.startTimeSeconds, overlayEndSeconds)) {
      const windowDurationSeconds = outputRange.outputEndSeconds - outputRange.outputStartSeconds;
      if (windowDurationSeconds <= 0) continue;
      const startTimeSeconds = outputRange.outputStartSeconds;
      const elapsedIntoWindowSeconds = outputRange.sourceOverlapStartSeconds - overlay.startTimeSeconds;

      const ttsSource = offlineContext.createBufferSource();
      ttsSource.buffer = ttsBuffer;
      const ttsGainNode = offlineContext.createGain();
      // Ducked against any active video-overlay audio sharing this window
      // via the same scheduleDuckedGainOffline/breakpoints the main track
      // and the video-overlay-audio block above both use -- see
      // sampleAudioMixAt's own doc comment for the mixer spec (background
      // music is NOT part of this mix; it plays unaffected by narration, a
      // deliberate scope decision, not an oversight).
      scheduleDuckedGainOffline(ttsGainNode, nominalGain, outputRange, breakpoints);
      ttsSource.connect(ttsGainNode).connect(offlineContext.destination);
      ttsSource.start(startTimeSeconds, elapsedIntoWindowSeconds, windowDurationSeconds);
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
  const { selections, sequenceClips, backgroundClips, assetUrlById, refreshAssetUrl, mainAudioVolume, backgroundVolume, outputWidth, outputHeight } =
    input;
  if (sequenceClips.length === 0) throw new Error("Nothing to render -- add a video to the sequence first.");

  const baseCropRect = selections.cropRect ?? FULL_FRAME_CROP_RECT;
  // `baseCropRect`/a user-dragged pan-zoom ZoomEffect are authored against
  // the sequence's REFERENCE clip (the first one -- see CanvasPlayer's
  // referenceFrameSizeRef), and need re-projecting onto each OTHER
  // segment's own real aspect ratio before use -- see reprojectCropRect's
  // own doc comment (video_math.ts) for why reusing it verbatim against a
  // differently-shaped clip stretches instead of cropping. Gated on
  // `selections.cropRect` being non-null (not just checked against the
  // FULL_FRAME_CROP_RECT fallback above) -- reprojectCropRect must never
  // be called when no clip rectangle ratio was ever chosen at all, only
  // when one was chosen and happens to equal full-frame for THIS clip
  // (see that function's own doc comment on why the two are otherwise
  // indistinguishable).
  const hasClipRectangle = selections.cropRect !== null;
  const referenceClip = sequenceClips[0];
  const referenceAspectRatio = referenceClip?.width && referenceClip?.height ? referenceClip.width / referenceClip.height : null;
  // Per-cutaway/per-overlay filter lookup, same "each clip carries its own
  // colorFilterId" model as compileCreatomateTimeline.ts's identical map --
  // see that file's own comment on cutawayFilterByEntryId.
  const cutawayFilterByEntryId = new Map(selections.sequenceClips.map((entry) => [entry.id, entry.colorFilterId ?? null]));
  // Per-cutaway canvas fill (see canvasFillPresets.ts) -- same "each clip
  // carries its own" shape as cutawayFilterByEntryId above.
  const canvasFillByEntryId = new Map(
    selections.sequenceClips.map((entry) => [
      entry.id,
      { mode: getCanvasFillMode(entry.canvasFillMode), color: entry.canvasFillColor, gradientColor: entry.canvasFillGradientColor },
    ])
  );
  // AI background removal -- same per-entryId matteAssetId lookup as
  // compileCreatomateTimeline.ts's own backgroundRemovalMatteByEntryId.
  // Only a REAL, already-completed matte is ever used here (never
  // CanvasPlayer's own MediaPipe approximate-cutout fallback) -- same
  // "final render only trusts a real matte" policy compileCreatomateTimeline.ts
  // already established (its own comment: "Only reachable once matteAssetId
  // is populated... falls back to whatever its canvasFillMode/crop would
  // already render as"). Running MediaPipe segmentation against every real
  // seeked export frame (unlike the preview's once-per-clip pre-extracted
  // frames) would be prohibitively slow for no better-than-preview result,
  // so a still-processing job (matteAssetId null) or a matte asset that
  // fails to load just renders this clip unmasked, exactly like today.
  const backgroundRemovalMatteByEntryId = new Map(
    selections.sequenceClips.map((entry) => [entry.id, entry.backgroundRemoval?.enabled ? entry.backgroundRemoval.matteAssetId : null])
  );
  // Same cut-transition lookup compileCreatomateTimeline.ts builds -- see
  // that file's own cutTransitionByEntryId comment.
  const cutTransitionByEntryId = new Map(selections.sequenceClips.map((entry) => [entry.id, entry.cutTransitionInId ?? null]));
  // "Make it 3D" (lib/video/camera3D.ts) -- same per-entryId lookup shape as
  // cutawayFilterByEntryId above, mirroring CanvasPlayer.tsx's identical
  // clipCamera3DById/clipTemplateIdsById maps so both render paths agree on
  // which cutaway gets the effect.
  const cutawayCamera3DByEntryId = new Map(
    selections.sequenceClips.map((entry) => [entry.id, entry.kind === "image" && Boolean(entry.camera3D)])
  );
  // Ambient overlay effect (lib/video/ambientEffects.ts) -- same per-entryId
  // lookup shape as cutawayCamera3DByEntryId above, mirroring CanvasPlayer's
  // clipAmbientEffectById.
  const cutawayAmbientEffectByEntryId = new Map(
    selections.sequenceClips.map((entry) => [entry.id, entry.kind === "image" ? (entry.ambientEffect ?? null) : null])
  );
  const cutawayTemplateIdsByEntryId = new Map(
    selections.sequenceClips.map((entry) => [entry.id, entry.kind === "image" ? normalizeImageTemplateIds(entry) : []])
  );
  const cssFilterFor = (colorFilterId: FilterPresetId | null | undefined) => getFilterPresetOption(colorFilterId ?? null).cssFilter;
  const segments = buildRenderSegments(sequenceClips, selections.trimRanges, cutTransitionByEntryId);
  // Overlapping segments overcount a naive sum -- see totalRenderOutputDuration's own doc comment.
  const totalDurationSeconds = totalRenderOutputDuration(segments);
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
  // AI background removal -- VIDEO mattes (VEED's luma-matte output, shared
  // shape whether the clip they key out is a base sequence clip or a video
  // overlay -- both are just "a real seekable video sharing its source
  // clip's own timeline exactly", see backgroundRemovalMatteByEntryId's own
  // comment) keyed by matteAssetId, NOT by the clip/overlay that references
  // it -- matting/repository.get_by_source_asset dedupes by source asset,
  // so more than one entry can point at the same matte.
  const matteVideoElementsByAssetId = new Map<string, HTMLVideoElement>();
  // AI background removal -- IMAGE mattes (a Ken Burns cutaway's own rembg
  // cutout, a full already-transparent PNG that REPLACES the original photo
  // outright rather than a separate mask -- see
  // compileCreatomateTimeline.ts's buildBackgroundRemovedImageSegment's own
  // comment) keyed by matteAssetId, same sharing convention as
  // matteVideoElementsByAssetId above.
  const matteImageElementsByAssetId = new Map<string, HTMLImageElement>();
  const overlayBlobUrls: string[] = [];
  const warnings: string[] = [];
  // "Make it 3D" (camera3D.ts) -- one shared WebGL context for the whole
  // export run, same reuse-across-frames reasoning as CanvasPlayer's own
  // camera3DRendererRef. Declared here (not inside the try block below) so
  // the `finally` clause can reach it to dispose, same pattern every other
  // cleanup-needing resource on this page already follows.
  const camera3DRenderer = new Camera3DRenderer();

  try {
    for (const clip of sequenceClips) {
      if (clip.kind === "image") {
        if (imageClipElementsByAssetId.has(clip.assetId)) continue;
        // Unlike an overlay image (decorative, skippable -- see the
        // overlayAssetIds loop below), a base sequence clip is not
        // optional: if it can't be loaded there's a real gap in the
        // output, so this stays fatal. It's still wrapped here (unlike
        // before) so the thrown error identifies which asset failed
        // instead of surfacing a bare, undiagnosable "Failed to fetch".
        try {
          const { image, blobUrl } = await loadOverlayImage(clip.url, { assetId: clip.assetId, refreshUrl: refreshAssetUrl });
          imageClipElementsByAssetId.set(clip.assetId, image);
          overlayBlobUrls.push(blobUrl);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new Error(`Could not load image clip (assetId ${clip.assetId}) for this render: ${reason}`);
        }
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
        const { image, blobUrl } = await loadOverlayImage(url, { assetId, refreshUrl: refreshAssetUrl });
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

    // AI background removal -- collects every matteAssetId actually needed
    // (a completed job's real matte only, see backgroundRemovalMatteByEntryId's
    // own comment) across BOTH the base sequence and video overlays, split
    // by which kind of matte it is (video-kind entries and every video
    // overlay use a luma-matte video; image-kind entries use a full
    // cutout PNG). A still-processing job (matteAssetId null) contributes
    // nothing here -- that clip/overlay just renders unmasked below, same
    // as it does in the live preview while waiting.
    const matteVideoAssetIds = new Set<string>();
    const matteImageAssetIds = new Set<string>();
    for (const entry of selections.sequenceClips) {
      const matteAssetId = entry.backgroundRemoval?.enabled ? entry.backgroundRemoval.matteAssetId : null;
      if (!matteAssetId) continue;
      (entry.kind === "video" ? matteVideoAssetIds : matteImageAssetIds).add(matteAssetId);
    }
    for (const overlay of selections.videoOverlays) {
      // "chromaKey" mode never uses a matte, even if one happens to be
      // stashed on a project saved before this file's own chroma-key
      // support existed -- see the loop's own draw branch below, which
      // routes "chromaKey" to drawImageFlippedChromaKeyed unconditionally.
      if (overlay.backgroundRemoval?.mode === "chromaKey") continue;
      const matteAssetId = overlay.backgroundRemoval?.enabled ? overlay.backgroundRemoval.matteAssetId : null;
      if (matteAssetId) matteVideoAssetIds.add(matteAssetId);
    }
    for (const matteAssetId of matteVideoAssetIds) {
      const url = assetUrlById[matteAssetId];
      if (!url) {
        const message = `A background-removal matte (assetId ${matteAssetId}) has no resolved URL -- that clip/overlay renders unmasked in this render.`;
        console.warn(`Edge Render: ${message}`);
        warnings.push(message);
        continue;
      }
      try {
        matteVideoElementsByAssetId.set(matteAssetId, await loadVideoElement(url, "auto"));
      } catch (err) {
        // Skipped -- graceful degrade to unmasked, same policy as every other optional asset above.
        const reason = err instanceof Error ? err.message : String(err);
        const message = `A background-removal matte (assetId ${matteAssetId}) couldn't be loaded for this render: ${reason}`;
        console.warn(`Edge Render: ${message}`);
        warnings.push(message);
      }
    }
    for (const matteAssetId of matteImageAssetIds) {
      const url = assetUrlById[matteAssetId];
      if (!url) {
        const message = `A background-removal cutout (assetId ${matteAssetId}) has no resolved URL -- that clip renders unmasked in this render.`;
        console.warn(`Edge Render: ${message}`);
        warnings.push(message);
        continue;
      }
      try {
        const { image, blobUrl } = await loadOverlayImage(url, { assetId: matteAssetId, refreshUrl: refreshAssetUrl });
        matteImageElementsByAssetId.set(matteAssetId, image);
        overlayBlobUrls.push(blobUrl);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const message = `A background-removal cutout (assetId ${matteAssetId}) couldn't be loaded for this render: ${reason}`;
        console.warn(`Edge Render: ${message}`);
        warnings.push(message);
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");

    // Scratch canvas for the background-removal masked composite (a base
    // clip's own "destination-in" branch below, and a video overlay's own),
    // same fixed-size-for-the-whole-export reuse as CanvasPlayer's own
    // maskCompositeCanvasRef -- this canvas never changes size mid-export
    // (unlike the live preview, whose canvas can resize), so it's allocated
    // once here rather than re-checked every frame.
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = outputWidth;
    maskCanvas.height = outputHeight;
    const maskCtx = maskCanvas.getContext("2d");

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
      // AI background removal -- a real, already-loaded matte only (see
      // backgroundRemovalMatteByEntryId's own comment). An IMAGE-kind
      // cutout REPLACES `source` outright right here (it's a full
      // already-transparent PNG, not a separate mask -- see
      // matteImageElementsByAssetId's own comment), so every crop/dimension
      // computation below naturally operates against the cutout's own
      // pixel size with no further special-casing. A VIDEO-kind matte is
      // NOT swapped in here -- it's a separate luma-matte video composited
      // alongside `source` in the new backgroundRemoval branch further
      // below (see `videoMatte`), since masking (unlike a plain
      // replacement) needs both the original frame AND the matte frame at
      // once.
      const matteAssetId = segment.entryId ? backgroundRemovalMatteByEntryId.get(segment.entryId) : null;
      const imageMatte = matteAssetId && segment.kind === "image" ? matteImageElementsByAssetId.get(matteAssetId) : undefined;
      const videoMatte = matteAssetId && segment.kind === "video" ? matteVideoElementsByAssetId.get(matteAssetId) : undefined;
      const source: HTMLVideoElement | HTMLImageElement | null =
        segment.kind === "image"
          ? (imageMatte ?? imageClipElementsByAssetId.get(segment.assetId) ?? null)
          : (videoElementsByAssetId.get(segment.assetId) ?? null);

      if (source instanceof HTMLVideoElement) {
        await seekVideoTo(source, localSeconds);
      }
      if (videoMatte) {
        // Shares `source`'s own local timeline exactly (see
        // matteVideoElementsByAssetId's own comment) -- seeked to the SAME
        // localSeconds, not a separately-computed time.
        await seekVideoTo(videoMatte, localSeconds);
      }

      // At most one of these is active at a time PER ARRAY (Full-Screen and
      // Split-Screen claim exclusivity over each other only within the same
      // clip type) -- see findActiveExclusiveOverlay's own doc comment. The
      // two arrays (video vs. image) CAN legitimately overlap in time with
      // each other; when both are active, image wins -- mirrors
      // CanvasPlayer.tsx's identical winningExclusiveLayout logic exactly,
      // see that file's own comment for the full rationale. `baseRect: null`
      // means an exclusive Full-Screen overlay is active, so the base clip
      // is skipped entirely below (the overlay's own draw, further down,
      // fully covers the canvas).
      const activeExclusiveImageOverlay = findActiveExclusiveOverlay(selections.overlayImages, sourceTimeSeconds);
      const activeExclusiveVideoOverlay = findActiveExclusiveOverlay(selections.videoOverlays, sourceTimeSeconds);
      const winningExclusiveLayout = (activeExclusiveImageOverlay ?? activeExclusiveVideoOverlay)?.layout ?? null;
      const { baseRect, overlayRect } = winningExclusiveLayout
        ? computeOverlayRects(winningExclusiveLayout)
        : { baseRect: FULL_FRAME_CROP_RECT, overlayRect: null };

      if (source) {
        const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
        const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
        const authoredCrop = computeEffectiveCropRect(baseCropRect, selections.zoomEffects, sourceTimeSeconds);
        // Self-scoped already for an image clip's own Ken Burns motion --
        // see reprojectCropRect's own doc comment for why only a video
        // segment's rect (always authored against the reference clip)
        // needs re-projecting here.
        const crop =
          !hasClipRectangle || segment.kind === "image" || referenceAspectRatio === null
            ? authoredCrop
            : reprojectCropRect(authoredCrop, referenceAspectRatio, sourceWidth / sourceHeight);
        const sx = crop.x * sourceWidth;
        const sy = crop.y * sourceHeight;
        const sWidth = crop.width * sourceWidth;
        const sHeight = crop.height * sourceHeight;

        const flipHorizontal = computeEffectiveFlip(selections.flipHorizontalToggles, sourceTimeSeconds);
        const flipVertical = computeEffectiveFlip(selections.flipVerticalToggles, sourceTimeSeconds);

        ctx.save();
        ctx.filter = cssFilterFor(segment.entryId ? cutawayFilterByEntryId.get(segment.entryId) : null);
        ctx.translate(flipHorizontal ? canvas.width : 0, flipVertical ? canvas.height : 0);
        ctx.scale(flipHorizontal ? -1 : 1, flipVertical ? -1 : 1);
        if (baseRect && winningExclusiveLayout?.type === "split-screen") {
          // A Split-Screen half's own box generally has a DIFFERENT aspect
          // ratio than `crop` -- cover-fit the already-cropped region into
          // it using this window's own baseFraming pan, exactly mirroring
          // CanvasPlayer's identical branch.
          const baseDestX = baseRect.x * canvas.width;
          const baseDestY = baseRect.y * canvas.height;
          const baseDestWidth = baseRect.width * canvas.width;
          const baseDestHeight = baseRect.height * canvas.height;
          const { panX, panY, zoom: baseZoom, flipHorizontal: baseFlipH, flipVertical: baseFlipV } =
            winningExclusiveLayout.baseFraming ?? DEFAULT_OVERLAY_FRAMING;
          const { sx: bsx, sy: bsy, sWidth: bsw, sHeight: bsh } = computeCoverFitSourceRect(
            sWidth, sHeight, baseDestWidth, baseDestHeight, panX, panY, baseZoom
          );
          drawImageFlipped(ctx, source, sx + bsx, sy + bsy, bsw, bsh, baseDestX, baseDestY, baseDestWidth, baseDestHeight, baseFlipH, baseFlipV);
        } else if (baseRect && matteAssetId && (imageMatte || videoMatte)) {
          // AI background removal -- masked cutout over a new backdrop,
          // same priority CanvasPlayer's own drawFrameAt gives this over the
          // letterbox/plain-crop branches below (see that file's own
          // comment). No canvasFillMode of "crop" makes sense once the
          // subject is cut out -- falls back to solid DEFAULT_CANVAS_FILL_COLOR,
          // same default compileCreatomateTimeline.ts's
          // buildBackgroundRemovedSegment and CanvasPlayer both already use,
          // so every render path agrees on it.
          const rawFill = segment.entryId ? (canvasFillByEntryId.get(segment.entryId) ?? { mode: "crop" as const }) : { mode: "crop" as const };
          const fill = rawFill.mode === "crop" ? { mode: "solid" as const, color: DEFAULT_CANVAS_FILL_COLOR, gradientColor: undefined as string | undefined } : rawFill;
          const canvasAspectRatio = canvas.width / canvas.height;
          const baseCssFilter = ctx.filter;
          if (fill.mode === "blur") {
            const bgCrop = computeMaxCoverageCropRect(sourceWidth, sourceHeight, canvasAspectRatio);
            const blurRadiusPx = CANVAS_FILL_BLUR_RADIUS_FRACTION * Math.max(canvas.width, canvas.height);
            ctx.filter = `${baseCssFilter === "none" ? "" : baseCssFilter} blur(${blurRadiusPx}px)`.trim();
            ctx.drawImage(source, bgCrop.x, bgCrop.y, bgCrop.width, bgCrop.height, 0, 0, canvas.width, canvas.height);
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

          if (videoMatte && maskCtx) {
            // VIDEO path: draw the cropped subject onto the scratch canvas,
            // then punch it down to just the matte's alpha via
            // "destination-in" before compositing that onto the real
            // canvas (still inside the still-active flip transform above),
            // on top of the backdrop just drawn -- same technique as
            // CanvasPlayer's own base-clip masked branch. `crop` is a
            // FRACTION (0..1), reapplied against the matte's own
            // videoWidth/videoHeight, not source's sx/sy/sWidth/sHeight
            // verbatim, since VEED's matte output isn't guaranteed to share
            // the source video's exact pixel dimensions.
            const matteSx = crop.x * videoMatte.videoWidth;
            const matteSy = crop.y * videoMatte.videoHeight;
            const matteSWidth = crop.width * videoMatte.videoWidth;
            const matteSHeight = crop.height * videoMatte.videoHeight;
            maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
            maskCtx.globalCompositeOperation = "source-over";
            maskCtx.drawImage(source, sx, sy, sWidth, sHeight, destX, destY, destWidth, destHeight);
            maskCtx.globalCompositeOperation = "destination-in";
            maskCtx.drawImage(videoMatte, matteSx, matteSy, matteSWidth, matteSHeight, destX, destY, destWidth, destHeight);
            ctx.drawImage(maskCanvas, 0, 0);
          } else {
            // IMAGE path (Ken Burns cutaway): `source` was already swapped
            // to the transparent cutout itself above -- a plain drawImage
            // on top of the backdrop just drawn lets its own per-pixel
            // alpha show that backdrop through natively, no scratch canvas
            // needed. Also the fallback if a video matte failed to load
            // (maskCtx null) -- draws the ORIGINAL unmasked frame rather
            // than nothing, same "looks normal, not broken" fallback spirit
            // as every other optional asset in this file.
            ctx.drawImage(source, sx, sy, sWidth, sHeight, destX, destY, destWidth, destHeight);
          }
        } else if (baseRect && (segment.entryId ? (canvasFillByEntryId.get(segment.entryId)?.mode ?? "crop") : "crop") !== "crop") {
          // Letterboxed/pillarboxed instead of cropped -- mirrors
          // CanvasPlayer's identical branch exactly (same
          // computeContainFitRect/computeMaxCoverageCropRect helpers), so
          // a local export matches the live preview frame-for-frame.
          const fill = canvasFillByEntryId.get(segment.entryId!)!;
          const canvasAspectRatio = canvas.width / canvas.height;
          const baseCssFilter = ctx.filter; // already this clip's own color filter, set above
          if (fill.mode === "blur") {
            const bgCrop = computeMaxCoverageCropRect(sourceWidth, sourceHeight, canvasAspectRatio);
            const blurRadiusPx = CANVAS_FILL_BLUR_RADIUS_FRACTION * Math.max(canvas.width, canvas.height);
            ctx.filter = `${baseCssFilter === "none" ? "" : baseCssFilter} blur(${blurRadiusPx}px)`.trim();
            ctx.drawImage(source, bgCrop.x, bgCrop.y, bgCrop.width, bgCrop.height, 0, 0, canvas.width, canvas.height);
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
          const containRect = computeContainFitRect(sourceWidth / sourceHeight, canvasAspectRatio);
          ctx.drawImage(
            source, 0, 0, sourceWidth, sourceHeight,
            containRect.x * canvas.width, containRect.y * canvas.height, containRect.width * canvas.width, containRect.height * canvas.height
          );
        } else if (baseRect) {
          // null only for an active Full-Screen overlay -- its own draw
          // below fully covers the canvas regardless, so skipping this is a
          // pure optimization, never load-bearing for correctness.
          const destX = baseRect.x * canvas.width;
          const destY = baseRect.y * canvas.height;
          const destWidth = baseRect.width * canvas.width;
          const destHeight = baseRect.height * canvas.height;
          // "Make it 3D" -- mirrors CanvasPlayer.tsx's identical branch
          // exactly (same computeCamera3DPoseForZoomEffect call, same
          // "flip already applied via the outer ctx transform" reasoning
          // for why both flip args are false), so the export matches the
          // live preview frame-for-frame.
          const activeZoomEffectIndex = segment.entryId && cutawayCamera3DByEntryId.get(segment.entryId) ? findActiveZoomEffectIndex(selections.zoomEffects, sourceTimeSeconds) : -1;
          if (activeZoomEffectIndex !== -1) {
            const pose = computeCamera3DPoseForZoomEffect(
              selections.zoomEffects[activeZoomEffectIndex],
              cutawayTemplateIdsByEntryId.get(segment.entryId!) ?? [],
              sourceTimeSeconds
            );
            camera3DRenderer.drawImage3D(ctx, source, pose, sx, sy, sWidth, sHeight, destX, destY, destWidth, destHeight, false, false);
          } else {
            ctx.drawImage(source, sx, sy, sWidth, sHeight, destX, destY, destWidth, destHeight);
          }
        }
        ctx.restore();

        // Ambient overlay effect (ambientEffects.ts) -- mirrors
        // CanvasPlayer's identical post-restore draw exactly (same
        // baseRect/localSeconds reasoning), so the export matches the live
        // preview frame-for-frame.
        if (baseRect && segment.entryId && cutawayAmbientEffectByEntryId.get(segment.entryId)) {
          drawAmbientEffect(
            ctx,
            cutawayAmbientEffectByEntryId.get(segment.entryId) ?? null,
            baseRect.x * canvas.width,
            baseRect.y * canvas.height,
            baseRect.width * canvas.width,
            baseRect.height * canvas.height,
            localSeconds,
            ambientEffectSeed(segment.entryId)
          );
        }
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }

      // The incoming side of a cut-transition blend -- the SAME
      // Fade/Slide/Wipe approximation (alpha/translate/clip-rect)
      // CanvasPlayer's own drawFrameAt uses, sourced here from a real
      // seeked <video>/<img> instead of a pre-extracted frame. Segments
      // already carry their own correctly-shifted outputStartSeconds (see
      // buildRenderSegments), so unlike CanvasPlayer this needs no separate
      // skip trick -- resolveRenderSegmentBlend just reads it straight off
      // the segment. Skipped (same KNOWN LIMITATION as CanvasPlayer)
      // whenever a Full-Screen/Split-Screen overlay is active at the same
      // instant.
      const blend = winningExclusiveLayout ? null : resolveRenderSegmentBlend(segments, outputTimeSeconds);
      if (blend) {
        const toSegment = blend.toSegment;
        const incomingSource: HTMLVideoElement | HTMLImageElement | null =
          toSegment.kind === "image"
            ? (imageClipElementsByAssetId.get(toSegment.assetId) ?? null)
            : (videoElementsByAssetId.get(toSegment.assetId) ?? null);
        if (incomingSource) {
          const incomingSourceTimeSeconds = toSegment.sourceStartSeconds + (outputTimeSeconds - toSegment.outputStartSeconds);
          const incomingLocalSeconds = toSegment.clipLocalStartSeconds + (outputTimeSeconds - toSegment.outputStartSeconds);
          if (incomingSource instanceof HTMLVideoElement) {
            await seekVideoTo(incomingSource, incomingLocalSeconds);
          }
          const incomingSourceWidth = incomingSource instanceof HTMLVideoElement ? incomingSource.videoWidth : incomingSource.naturalWidth;
          const incomingSourceHeight = incomingSource instanceof HTMLVideoElement ? incomingSource.videoHeight : incomingSource.naturalHeight;
          const authoredIncomingCrop = computeEffectiveCropRect(baseCropRect, selections.zoomEffects, incomingSourceTimeSeconds);
          const incomingCrop =
            !hasClipRectangle || toSegment.kind === "image" || referenceAspectRatio === null
              ? authoredIncomingCrop
              : reprojectCropRect(authoredIncomingCrop, referenceAspectRatio, incomingSourceWidth / incomingSourceHeight);
          const incomingSx = incomingCrop.x * incomingSourceWidth;
          const incomingSy = incomingCrop.y * incomingSourceHeight;
          const incomingSWidth = incomingCrop.width * incomingSourceWidth;
          const incomingSHeight = incomingCrop.height * incomingSourceHeight;
          const incomingFlipH = computeEffectiveFlip(selections.flipHorizontalToggles, incomingSourceTimeSeconds);
          const incomingFlipV = computeEffectiveFlip(selections.flipVerticalToggles, incomingSourceTimeSeconds);
          const destX = baseRect ? baseRect.x * canvas.width : 0;
          const destY = baseRect ? baseRect.y * canvas.height : 0;
          const destWidth = baseRect ? baseRect.width * canvas.width : canvas.width;
          const destHeight = baseRect ? baseRect.height * canvas.height : canvas.height;

          ctx.save();
          ctx.filter = cssFilterFor(toSegment.entryId ? cutawayFilterByEntryId.get(toSegment.entryId) : null);
          if (toSegment.cutTransitionInId === "wipe") {
            // Reveal grows left-to-right -- an approximation of WipeLeft's
            // own geometry, not a literal match (see drawFrameAt's identical
            // disclaimer in CanvasPlayer.tsx).
            ctx.beginPath();
            ctx.rect(destX, destY, destWidth * blend.progress, destHeight);
            ctx.clip();
          } else if (toSegment.cutTransitionInId !== "slide") {
            ctx.globalAlpha = blend.progress; // "fade" (or an unset/legacy id defaulting to it)
          }
          // Slides in from the right, covering the outgoing frame
          // underneath -- a "push" reveal, not a true dual-slide.
          const slideOffsetX = toSegment.cutTransitionInId === "slide" ? (1 - blend.progress) * destWidth : 0;
          drawImageFlipped(
            ctx, incomingSource, incomingSx, incomingSy, incomingSWidth, incomingSHeight,
            destX + slideOffsetX, destY, destWidth, destHeight, incomingFlipH, incomingFlipV
          );
          ctx.restore();
        }
      }

      // Composited AFTER the flip transform above is undone -- an overlay
      // (image or video) is independent of the base clip's own flip state.
      // Image wins over video when both are active (see this loop's own
      // comment above on winningExclusiveLayout).
      if (activeExclusiveImageOverlay && overlayRect) {
        const overlayImage = overlayImagesByAssetId.get(activeExclusiveImageOverlay.assetId);
        if (overlayImage) {
          const destX = overlayRect.x * canvas.width;
          const destY = overlayRect.y * canvas.height;
          const destWidth = overlayRect.width * canvas.width;
          const destHeight = overlayRect.height * canvas.height;
          const { sx: osx, sy: osy, sWidth: osw, sHeight: osh } = computeCoverFitSourceRect(
            overlayImage.naturalWidth, overlayImage.naturalHeight, destWidth, destHeight,
            activeExclusiveImageOverlay.framing.panX, activeExclusiveImageOverlay.framing.panY, activeExclusiveImageOverlay.framing.zoom
          );
          ctx.filter = cssFilterFor(activeExclusiveImageOverlay.colorFilterId);
          if (activeExclusiveImageOverlay.camera3D) {
            const pose = computeCamera3DPoseForOverlay(activeExclusiveImageOverlay.startTimeSeconds, activeExclusiveImageOverlay.endTimeSeconds, sourceTimeSeconds);
            camera3DRenderer.drawImage3D(
              ctx, overlayImage, pose, osx, osy, osw, osh, destX, destY, destWidth, destHeight,
              activeExclusiveImageOverlay.framing.flipHorizontal, activeExclusiveImageOverlay.framing.flipVertical
            );
          } else {
            drawImageFlipped(
              ctx, overlayImage, osx, osy, osw, osh, destX, destY, destWidth, destHeight,
              activeExclusiveImageOverlay.framing.flipHorizontal, activeExclusiveImageOverlay.framing.flipVertical
            );
          }
          ctx.filter = "none";
          if (activeExclusiveImageOverlay.ambientEffect) {
            drawAmbientEffect(
              ctx, activeExclusiveImageOverlay.ambientEffect, destX, destY, destWidth, destHeight,
              sourceTimeSeconds - activeExclusiveImageOverlay.startTimeSeconds, ambientEffectSeed(activeExclusiveImageOverlay.startTimeSeconds)
            );
          }
        }
      } else if (activeExclusiveVideoOverlay && overlayRect) {
        const overlayVideo = videoOverlayElementsByAssetId.get(activeExclusiveVideoOverlay.assetId);
        if (overlayVideo) {
          const localOffsetSeconds = activeExclusiveVideoOverlay.sourceStartSeconds + (sourceTimeSeconds - activeExclusiveVideoOverlay.startTimeSeconds);
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
            activeExclusiveVideoOverlay.framing.panX, activeExclusiveVideoOverlay.framing.panY, activeExclusiveVideoOverlay.framing.zoom
          );
          ctx.filter = cssFilterFor(activeExclusiveVideoOverlay.colorFilterId);
          const overlayBackgroundRemoval = activeExclusiveVideoOverlay.backgroundRemoval?.enabled
            ? activeExclusiveVideoOverlay.backgroundRemoval
            : null;
          if (overlayBackgroundRemoval?.mode === "chromaKey") {
            // Chroma key never depends on fal.ai, not even at render time --
            // see chromaKey.ts's own module comment. Keyed live, right here,
            // from this exact seeked frame.
            drawImageFlippedChromaKeyed(
              ctx, maskCanvas, overlayVideo, hexToRgb(overlayBackgroundRemoval.chromaKeyColor ?? DEFAULT_CHROMA_KEY_COLOR),
              osx, osy, osw, osh, destX, destY, destWidth, destHeight,
              activeExclusiveVideoOverlay.framing.flipHorizontal, activeExclusiveVideoOverlay.framing.flipVertical
            );
          } else {
            // AI background removal -- a real, already-loaded matte only (see
            // matteVideoElementsByAssetId's own comment); a still-processing
            // job just draws this overlay unmasked, same graceful degrade as
            // the base clip's own branch above.
            const overlayMatteAssetId = overlayBackgroundRemoval?.matteAssetId ?? null;
            const overlayMatte = overlayMatteAssetId ? matteVideoElementsByAssetId.get(overlayMatteAssetId) : undefined;
            if (overlayMatte && maskCtx) {
              await seekVideoTo(overlayMatte, loopedOffsetSeconds);
              drawImageFlippedMasked(
                ctx, maskCanvas, overlayVideo, overlayMatte,
                osx, osy, osw, osh,
                (osx / overlayVideo.videoWidth) * overlayMatte.videoWidth, (osy / overlayVideo.videoHeight) * overlayMatte.videoHeight,
                (osw / overlayVideo.videoWidth) * overlayMatte.videoWidth, (osh / overlayVideo.videoHeight) * overlayMatte.videoHeight,
                destX, destY, destWidth, destHeight,
                activeExclusiveVideoOverlay.framing.flipHorizontal, activeExclusiveVideoOverlay.framing.flipVertical
              );
            } else if (activeExclusiveVideoOverlay.camera3D) {
              const pose = computeCamera3DPoseForOverlay(activeExclusiveVideoOverlay.startTimeSeconds, activeExclusiveVideoOverlay.endTimeSeconds, sourceTimeSeconds);
              camera3DRenderer.drawImage3D(
                ctx, overlayVideo, pose, osx, osy, osw, osh, destX, destY, destWidth, destHeight,
                activeExclusiveVideoOverlay.framing.flipHorizontal, activeExclusiveVideoOverlay.framing.flipVertical
              );
            } else {
              drawImageFlipped(
                ctx, overlayVideo, osx, osy, osw, osh, destX, destY, destWidth, destHeight,
                activeExclusiveVideoOverlay.framing.flipHorizontal, activeExclusiveVideoOverlay.framing.flipVertical
              );
            }
          }
          ctx.filter = "none";
          if (activeExclusiveVideoOverlay.ambientEffect) {
            drawAmbientEffect(
              ctx, activeExclusiveVideoOverlay.ambientEffect, destX, destY, destWidth, destHeight,
              sourceTimeSeconds - activeExclusiveVideoOverlay.startTimeSeconds, ambientEffectSeed(activeExclusiveVideoOverlay.startTimeSeconds)
            );
          }
        }
      }

      // Picture-in-Picture VIDEO overlays float on top of whatever's
      // showing -- unlike the exclusive layouts, any number can be active
      // at once.
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
          overlayVideo.videoWidth, overlayVideo.videoHeight, destWidth, destHeight, pip.framing.panX, pip.framing.panY, pip.framing.zoom, MIN_PICTURE_IN_PICTURE_ZOOM
        );
        ctx.filter = cssFilterFor(pip.colorFilterId);
        const pipBackgroundRemoval = pip.backgroundRemoval?.enabled ? pip.backgroundRemoval : null;
        if (pipBackgroundRemoval?.mode === "chromaKey") {
          drawImageFlippedChromaKeyed(
            ctx, maskCanvas, overlayVideo, hexToRgb(pipBackgroundRemoval.chromaKeyColor ?? DEFAULT_CHROMA_KEY_COLOR),
            psx, psy, psw, psh, destX, destY, destWidth, destHeight,
            pip.framing.flipHorizontal, pip.framing.flipVertical
          );
        } else {
          const pipMatteAssetId = pipBackgroundRemoval?.matteAssetId ?? null;
          const pipMatte = pipMatteAssetId ? matteVideoElementsByAssetId.get(pipMatteAssetId) : undefined;
          if (pipMatte && maskCtx) {
            await seekVideoTo(pipMatte, loopedOffsetSeconds);
            drawImageFlippedMasked(
              ctx, maskCanvas, overlayVideo, pipMatte,
              psx, psy, psw, psh,
              (psx / overlayVideo.videoWidth) * pipMatte.videoWidth, (psy / overlayVideo.videoHeight) * pipMatte.videoHeight,
              (psw / overlayVideo.videoWidth) * pipMatte.videoWidth, (psh / overlayVideo.videoHeight) * pipMatte.videoHeight,
              destX, destY, destWidth, destHeight,
              pip.framing.flipHorizontal, pip.framing.flipVertical
            );
          } else if (pip.camera3D) {
            const pose = computeCamera3DPoseForOverlay(pip.startTimeSeconds, pip.endTimeSeconds, sourceTimeSeconds);
            camera3DRenderer.drawImage3D(ctx, overlayVideo, pose, psx, psy, psw, psh, destX, destY, destWidth, destHeight, pip.framing.flipHorizontal, pip.framing.flipVertical);
          } else {
            drawImageFlipped(ctx, overlayVideo, psx, psy, psw, psh, destX, destY, destWidth, destHeight, pip.framing.flipHorizontal, pip.framing.flipVertical);
          }
        }
        ctx.filter = "none";
        if (pip.ambientEffect) {
          drawAmbientEffect(ctx, pip.ambientEffect, destX, destY, destWidth, destHeight, sourceTimeSeconds - pip.startTimeSeconds, ambientEffectSeed(pip.startTimeSeconds));
        }
      }

      // Picture-in-Picture IMAGE overlays draw AFTER video PiP overlays, so
      // an image PiP wins visually if it happens to overlap a video PiP box
      // -- same "image wins" convention as the exclusive layer above.
      for (const pip of findActivePictureInPictureOverlays(selections.overlayImages, sourceTimeSeconds)) {
        if (pip.layout.type !== "picture-in-picture") continue; // narrows the type for pip.layout.rect below
        const overlayImage = overlayImagesByAssetId.get(pip.assetId);
        if (!overlayImage) continue;
        const destX = pip.layout.rect.x * canvas.width;
        const destY = pip.layout.rect.y * canvas.height;
        const destWidth = pip.layout.rect.width * canvas.width;
        const destHeight = pip.layout.rect.height * canvas.height;
        const { sx: psx, sy: psy, sWidth: psw, sHeight: psh } = computeCoverFitSourceRect(
          overlayImage.naturalWidth, overlayImage.naturalHeight, destWidth, destHeight, pip.framing.panX, pip.framing.panY, pip.framing.zoom, MIN_PICTURE_IN_PICTURE_ZOOM
        );
        ctx.filter = cssFilterFor(pip.colorFilterId);
        if (pip.camera3D) {
          const pose = computeCamera3DPoseForOverlay(pip.startTimeSeconds, pip.endTimeSeconds, sourceTimeSeconds);
          camera3DRenderer.drawImage3D(ctx, overlayImage, pose, psx, psy, psw, psh, destX, destY, destWidth, destHeight, pip.framing.flipHorizontal, pip.framing.flipVertical);
        } else {
          drawImageFlipped(ctx, overlayImage, psx, psy, psw, psh, destX, destY, destWidth, destHeight, pip.framing.flipHorizontal, pip.framing.flipVertical);
        }
        ctx.filter = "none";
        if (pip.ambientEffect) {
          drawAmbientEffect(ctx, pip.ambientEffect, destX, destY, destWidth, destHeight, sourceTimeSeconds - pip.startTimeSeconds, ambientEffectSeed(pip.startTimeSeconds));
        }
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

      // TTS narration overlays -- same two displayModes CanvasPlayer's live
      // preview draws (see that file's own comment): "background" reuses the
      // exact same template renderer as a plain TextOverlay above, "karaoke"
      // uses the shared drawKaraokeCaption (textTemplates.ts), driven by the
      // synthesis engine's own exact per-word timings (findActiveWordIndex),
      // not ASR -- this is why it's safe to burn in here identically to the
      // live preview, unlike auto-captions (transcriptCaption), which stay
      // Creatomate-only (see this file's own module comment).
      for (const overlay of findActiveTtsOverlays(selections.ttsOverlays, sourceTimeSeconds)) {
        const rectPx = {
          x: overlay.rect.x * canvas.width,
          y: overlay.rect.y * canvas.height,
          width: overlay.rect.width * canvas.width,
          height: overlay.rect.height * canvas.height,
        };
        if (overlay.displayMode === "none") continue; // audio-only narration -- nothing drawn
        if (overlay.displayMode === "karaoke") {
          drawKaraokeCaption(ctx, rectPx, overlay.wordTimings, findActiveWordIndex(overlay, sourceTimeSeconds), overlay.templateId);
          continue;
        }
        const renderer = getTextTemplateRenderer(overlay.templateId);
        if (!renderer) continue;
        renderer({
          ctx,
          text: overlay.text,
          rectPx,
          progress: computeProgress(overlay.startTimeSeconds, ttsOverlayEndTimeSeconds(overlay), sourceTimeSeconds),
        });
      }

      // Automatic branding -- always drawn last, on top of every other
      // overlay/caption, so nothing else on the timeline can cover it. Not
      // user-authored (see brandWatermark.ts's own module comment); a
      // no-op outside the final BRAND_WATERMARK_DURATION_SECONDS of the
      // sequence. Timed against outputTimeSeconds/totalDurationSeconds
      // (the OUTPUT timeline), not sourceTimeSeconds (a position within
      // whichever clip is currently playing) -- same distinction
      // CanvasPlayer's own elapsedSeconds draws against.
      drawBrandWatermark(ctx, canvas.width, canvas.height, outputTimeSeconds, totalDurationSeconds);

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
        selections.ttsOverlays,
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
    camera3DRenderer.dispose();
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
