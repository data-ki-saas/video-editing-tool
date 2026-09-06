/**
 * Small helpers for the camera Record page (components/editor-v2/
 * CameraCapturePage.tsx): picking a MediaRecorder mimeType the current
 * browser can actually produce, and converting whatever that produced into
 * an `video/mp4` File -- the only video mime type backend/src/assets/
 * service.py's `_ALLOWED_TYPES` accepts (see that file's own allow-list).
 *
 * MediaRecorder itself is used for the live capture (not mediabunny/
 * WebCodecs directly) since it's the one browser API that already handles
 * synchronized audio+video capture with native pause()/resume() across
 * every major browser -- hand-rolling that via WebCodecs would mean
 * manually encoding live microphone PCM frame-by-frame (no
 * MediaStreamTrackProcessor outside Chromium), which MediaRecorder gets for
 * free. mediabunny (already a dependency, used for lib/localRender/
 * exportTimeline.ts's export pipeline) is reused here purely for its
 * `Conversion` class -- a file-level remux/transcode, exactly the "convert
 * whatever MediaRecorder gave us into mp4" step this needs, whenever
 * MediaRecorder itself didn't already produce mp4 directly (Safari can).
 */
import { BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, ALL_FORMATS, canEncodeVideo, canEncodeAudio } from "mediabunny";

// Preference order: native mp4 (Safari) first -- skips the conversion step
// below entirely -- then the webm codec combinations most browsers actually
// support, most-compatible audio (opus) paired with whichever video codec
// wins, matching the same "probe in order, first supported wins" pattern
// exportTimeline.ts's own pickOutputFormat helper uses.
const MIME_TYPE_CANDIDATES = [
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

/** The first MediaRecorder mimeType this browser reports as supported, or
 * null if none of the candidates are (MediaRecorder itself unsupported --
 * callers should treat that as "recording unavailable in this browser"). */
export function pickMediaRecorderMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_TYPE_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? null;
}

/** Converts `blob` to an `video/mp4` File named `filename` -- a no-op
 * rewrap (no re-encode) when it's already mp4, otherwise a real mediabunny
 * transcode (whatever codec MediaRecorder used -> H.264/AAC in an mp4
 * container, the one combination every downstream consumer of a project
 * asset -- duration probing, Creatomate cloud render, thumbnailing --
 * already assumes). */
export async function toMp4Asset(blob: Blob, filename: string): Promise<File> {
  if (blob.type.startsWith("video/mp4")) {
    return new File([blob], filename, { type: "video/mp4" });
  }

  const canH264 = await canEncodeVideo("avc");
  const canAac = await canEncodeAudio("aac");
  if (!canH264) {
    throw new Error("This browser can't encode H.264 video, so the recording can't be saved as mp4.");
  }

  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target });

  const conversion = await Conversion.init({
    input,
    output,
    video: { codec: "avc" },
    audio: canAac ? { codec: "aac" } : { discard: true },
  });
  await conversion.execute();

  if (!target.buffer) throw new Error("mp4 conversion produced no output");
  return new File([target.buffer], filename, { type: "video/mp4" });
}
