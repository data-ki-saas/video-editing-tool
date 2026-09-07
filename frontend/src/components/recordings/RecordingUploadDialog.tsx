"use client";

/**
 * "Upload" button popup for the Recordings library -- lets a user add
 * existing footage (not captured live) straight into their personal
 * Recordings library. A picked video is checked client-side against this
 * library's own duration/frame-rate limits BEFORE it ever reaches the
 * network, same spirit as CameraCapturePage's own MAX_RECORDING_SECONDS cap
 * (also enforced client-side only there). Duration is re-verified
 * server-side too (recordings/service.py, via mutagen); frame rate isn't --
 * see that file's own comment on why a reliable server-side probe isn't
 * available in this backend today, so the check here is this feature's only
 * line of defense against an over-fps upload.
 *
 * Frame rate has no cheap/sync read on a video file (unlike duration) --
 * mediabunny's InputVideoTrack.computeFrameRateMetrics() demuxes and
 * samples actual packet timestamps, so this is a real (if brief) async
 * probe, not a metadata-header read.
 */
import { useRef, useState } from "react";
import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { uploadRecordingWithProgress, type Recording } from "@/lib/api";
import { getVideoDuration } from "@/lib/video/video";

const MAX_DURATION_SECONDS = 180;
const MAX_FRAME_RATE = 30;
const ACCEPTED_FILE_TYPES = "video/mp4,image/jpeg";

function defaultNameFromFilename(filename: string): string {
  return filename.replace(/\.[^/.]+$/, "") || "Recording";
}

/** Probes `file` (already known to be video/mp4) for duration and frame
 * rate, throwing a user-facing Error if either exceeds this library's caps.
 * Returns the measured duration on success, for uploadRecordingWithProgress
 * to store (more accurate than trusting anything client-computed
 * elsewhere). */
async function probeAndValidateVideo(file: File): Promise<number> {
  const objectUrl = URL.createObjectURL(file);
  let durationSeconds: number;
  try {
    durationSeconds = await getVideoDuration(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  if (durationSeconds > MAX_DURATION_SECONDS) {
    throw new Error(
      `Videos are limited to ${Math.round(MAX_DURATION_SECONDS / 60)} minutes (this one is ${Math.round(durationSeconds)}s).`
    );
  }

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (track) {
    const { bestGuessFrameRate } = await track.computeFrameRateMetrics();
    if (Math.round(bestGuessFrameRate) > MAX_FRAME_RATE) {
      throw new Error(
        `Videos are limited to ${MAX_FRAME_RATE}fps (this one is about ${Math.round(bestGuessFrameRate)}fps).`
      );
    }
  }

  return durationSeconds;
}

export function RecordingUploadDialog({
  onUploaded,
  onClose,
}: {
  onUploaded: (recording: Recording) => void;
  onClose: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    if (file.type !== "video/mp4" && file.type !== "image/jpeg") {
      setError("Only .mp4 videos or .jpg photos are supported.");
      return;
    }

    setIsBusy(true);
    setProgress(0);
    try {
      let durationSeconds: number | null = null;
      if (file.type === "video/mp4") {
        setStage("Checking video…");
        durationSeconds = await probeAndValidateVideo(file);
      }
      setStage("Uploading…");
      const recording = await uploadRecordingWithProgress(
        file,
        defaultNameFromFilename(file.name),
        null,
        durationSeconds,
        (fraction) => setProgress(fraction)
      );
      onUploaded(recording);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsBusy(false);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    if (isBusy) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // lets the same file be re-selected later
    if (file) void handleFile(file);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Upload a recording"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Upload a recording</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => !isBusy && fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          aria-disabled={isBusy}
          className={
            "flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-10 text-center text-sm " +
            (isBusy
              ? "cursor-not-allowed border-border text-muted"
              : isDragging
                ? "cursor-pointer border-accent bg-accent/10"
                : "cursor-pointer border-border text-muted hover:bg-background")
          }
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_FILE_TYPES}
            className="hidden"
            onChange={handleFileSelected}
            disabled={isBusy}
          />
          <span>Drag &amp; drop a video or photo here, or click to browse</span>
          <span className="text-xs">MP4 (up to 3 minutes, 30fps) or JPG</span>
        </div>

        {isBusy && (
          <div className="mt-3 flex flex-col gap-1">
            <div className="h-2 w-full overflow-hidden rounded-full bg-border">
              <div
                className="h-full bg-accent transition-[width]"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <span className="text-xs text-muted">
              {stage} {stage === "Uploading…" ? `${Math.round(progress * 100)}%` : ""}
            </span>
          </div>
        )}

        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
