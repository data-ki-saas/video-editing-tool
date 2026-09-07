/**
 * Renders a recording down to just its kept (non-cut) ranges into a single
 * new mp4 -- backs RecordingEditDialog's video Save, once the user has laid
 * out one or more cuts on the same TrimTrack widget the main editor uses.
 *
 * mediabunny's own `Conversion` (see lib/media/cameraRecording.ts's
 * toMp4Asset/trimToMp4Asset) only ever trims to ONE contiguous
 * {start, end} range -- it has no concept of multiple disjoint kept
 * stretches. So a genuine multi-cut export (removing a stretch from the
 * MIDDLE of a clip, not just its head/tail) needs a real per-frame
 * re-encode instead: this deliberately mirrors lib/localRender/
 * exportTimeline.ts's own recipe (seek a real <video> element to each
 * output frame's source time, draw it to a canvas, feed the canvas to a
 * CanvasSource; decode the whole audio track once, splice out the kept
 * ranges, feed the result to an AudioBufferSource) rather than inventing a
 * new one -- every primitive below (loadVideoElement/seekVideoTo,
 * decodeAudioBuffer/concatenateAudioBuffers, CanvasSource/AudioBufferSource/
 * Quality/canEncodeVideo/canEncodeAudio) is the exact function that file
 * already uses in production, just scoped to one video and its own kept
 * ranges instead of a whole project's multi-clip sequence.
 */
import { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality, canEncodeAudio, canEncodeVideo } from "mediabunny";
import { loadVideoElement, seekVideoTo } from "@/lib/video/video";
import { concatenateAudioBuffers, decodeAudioBuffer } from "@/lib/video/audio";
import type { TrimRange } from "@/lib/video/video_math";

// Same values as exportTimeline.ts's own OUTPUT_FPS/KEY_FRAME_INTERVAL_SECONDS
// -- no reason for this smaller, single-clip export to look or behave
// differently from the main render pipeline's own output.
const OUTPUT_FPS = 30;
const KEY_FRAME_INTERVAL_SECONDS = 3;

/** Extracts [startTimeSeconds, endTimeSeconds) of `buffer`, zero-padded if
 * the range runs past the buffer's own end (shouldn't normally happen --
 * keptRanges are derived from this same buffer's source duration -- but
 * keeps this a pure, always-succeeds slice rather than an out-of-bounds
 * throw). */
function sliceAudioBuffer(context: BaseAudioContext, buffer: AudioBuffer, startTimeSeconds: number, endTimeSeconds: number): AudioBuffer {
  const startSample = Math.max(0, Math.floor(startTimeSeconds * buffer.sampleRate));
  const endSample = Math.min(buffer.length, Math.ceil(endTimeSeconds * buffer.sampleRate));
  const length = Math.max(1, endSample - startSample);
  const sliced = context.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    sliced.getChannelData(channel).set(buffer.getChannelData(channel).subarray(startSample, endSample));
  }
  return sliced;
}

export async function exportTrimmedRecording(
  blob: Blob,
  keptRanges: TrimRange[],
  filename: string,
  onProgress?: (fraction: number) => void
): Promise<File> {
  if (keptRanges.length === 0) {
    throw new Error("Nothing left to save -- at least one part of the recording must survive the cuts.");
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const video = await loadVideoElement(objectUrl, "auto");
    const width = video.videoWidth;
    const height = video.videoHeight;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");

    const canH264 = await canEncodeVideo("avc", { width, height });
    if (!canH264) throw new Error("This browser can't encode H.264 video, so this edit can't be saved.");
    const canAac = await canEncodeAudio("aac");

    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });

    const videoSource = new CanvasSource(canvas, {
      codec: "avc",
      quality: new Quality("high"),
      keyFrameInterval: KEY_FRAME_INTERVAL_SECONDS,
    });
    output.addVideoTrack(videoSource);

    const audioSource = canAac ? new AudioBufferSource({ codec: "aac", quality: new Quality("high") }) : null;
    if (audioSource) output.addAudioTrack(audioSource);

    await output.start();

    const totalOutputFrames = keptRanges.reduce(
      (sum, range) => sum + Math.max(1, Math.round((range.endTimeSeconds - range.startTimeSeconds) * OUTPUT_FPS)),
      0
    );
    let outputTimeSeconds = 0;
    let framesDone = 0;

    for (const range of keptRanges) {
      const frameCount = Math.max(1, Math.round((range.endTimeSeconds - range.startTimeSeconds) * OUTPUT_FPS));
      for (let i = 0; i < frameCount; i++) {
        const sourceTimeSeconds = Math.min(range.endTimeSeconds, range.startTimeSeconds + i / OUTPUT_FPS);
        await seekVideoTo(video, sourceTimeSeconds);
        ctx.drawImage(video, 0, 0, width, height);
        await videoSource.add(outputTimeSeconds, 1 / OUTPUT_FPS);
        outputTimeSeconds += 1 / OUTPUT_FPS;
        framesDone += 1;
        // Video frames are the overwhelming majority of the work here --
        // the audio splice below is comparatively instant -- so progress is
        // reported purely off frame count, capped at 90% until finalize().
        onProgress?.(Math.min(0.9, framesDone / totalOutputFrames));
      }
    }

    if (audioSource) {
      try {
        const fullAudioBuffer = await decodeAudioBuffer(objectUrl);
        // A plain createBuffer factory, never rendered -- same "OfflineAudioContext
        // purely for allocation" use as lib/video/audio.ts's own concatenateAudioBuffers
        // doc comment describes for exportTimeline.ts's offline mix.
        const bufferFactory = new OfflineAudioContext(fullAudioBuffer.numberOfChannels, 1, fullAudioBuffer.sampleRate);
        const slices = keptRanges.map((range) =>
          sliceAudioBuffer(bufferFactory, fullAudioBuffer, range.startTimeSeconds, range.endTimeSeconds)
        );
        const combined = slices.length === 1 ? slices[0] : concatenateAudioBuffers(bufferFactory, slices);
        await audioSource.add(combined);
      } catch {
        // No audio track (a silent recording) or a decode failure -- a
        // video-only export is still a valid save, same graceful-skip
        // convention as toMp4Asset's own audio handling.
      }
    }

    await output.finalize();
    onProgress?.(1);

    if (!target.buffer) throw new Error("Export produced no output");
    return new File([target.buffer], filename, { type: "video/mp4" });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
