"use client";

/**
 * Popup editor for one recording -- trim (video) or crop (photo), Save
 * overwrites it in place (same id/name/description, underlying file
 * replaced). Modal chrome copied from editor-v2/UploadDialog.tsx.
 *
 * Loads the recording's current bytes via a real CORS-mode fetch (see
 * lib/crossOriginImage.ts's own module comment on why a plain <video src>/
 * <img src> can't be trusted before a later pixel-level read -- a stray
 * no-cors load elsewhere can poison the browser's cache for this exact URL)
 * rather than pointing straight at the recording's presigned URL, since both
 * branches below need to read pixels/bytes back out (canvas for the photo
 * crop, mediabunny's BlobSource for the video trim).
 */
import { useEffect, useRef, useState } from "react";
import { replaceRecordingContentWithProgress, type Recording } from "@/lib/api";
import { trimToMp4Asset } from "@/lib/media/cameraRecording";
import { loadCrossOriginImage } from "@/lib/crossOriginImage";
import { CropRectOverlay } from "@/components/editor-v2/CropRectOverlay";
import type { CropRect } from "@/lib/video/video_math";

const IDENTITY_CROP_RECT: CropRect = { x: 0, y: 0, width: 1, height: 1 };
// Half a second of slack so a handle can never be dragged past its
// counterpart into a zero/negative-length trim.
const MIN_TRIM_LENGTH_SECONDS = 0.5;

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** A single in/out trim range on a thin bar -- two draggable handles
 * (start, end), the kept region highlighted between them. Deliberately NOT
 * editor-v2/TrimTrack.tsx, whose click-to-cut/multi-segment model fits the
 * main timeline's "cut stretches out of the middle" semantics -- this needs
 * just one contiguous kept range, which is also all mediabunny's own
 * Conversion `trim` option supports (a single start/end, not arbitrary
 * multi-segment cuts). */
function RangeTrimBar({
  durationSeconds,
  start,
  end,
  onChange,
}: {
  durationSeconds: number;
  start: number;
  end: number;
  onChange: (next: { start: number; end: number }) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);

  function startDrag(handle: "start" | "end") {
    return (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const track = trackRef.current;
      if (!track || durationSeconds <= 0) return;
      const rect = track.getBoundingClientRect();

      function apply(clientX: number) {
        const fraction = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1);
        const time = fraction * durationSeconds;
        if (handle === "start") onChange({ start: Math.min(time, end - MIN_TRIM_LENGTH_SECONDS), end });
        else onChange({ start, end: Math.max(time, start + MIN_TRIM_LENGTH_SECONDS) });
      }
      function handleMove(ev: PointerEvent) {
        apply(ev.clientX);
      }
      function handleUp(ev: PointerEvent) {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        apply(ev.clientX);
      }
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    };
  }

  const toPercent = (seconds: number) => (durationSeconds > 0 ? (seconds / durationSeconds) * 100 : 0);

  return (
    <div ref={trackRef} className="relative h-3 w-full shrink-0 rounded-sm bg-neutral-700">
      <div
        className="absolute top-0 h-full rounded-sm bg-accent/70"
        style={{ left: `${toPercent(start)}%`, width: `${toPercent(end - start)}%` }}
      />
      <div
        onPointerDown={startDrag("start")}
        title="Drag to move the start"
        className="absolute top-1/2 z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border border-white bg-accent"
        style={{ left: `${toPercent(start)}%` }}
      />
      <div
        onPointerDown={startDrag("end")}
        title="Drag to move the end"
        className="absolute top-1/2 z-10 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border border-white bg-accent"
        style={{ left: `${toPercent(end)}%` }}
      />
    </div>
  );
}

export function RecordingEditDialog({
  recording,
  onSave,
  onClose,
}: {
  recording: Recording;
  onSave: (updated: Recording) => void;
  onClose: () => void;
}) {
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [imageElement, setImageElement] = useState<HTMLImageElement | null>(null);

  const [durationSeconds, setDurationSeconds] = useState(recording.durationSeconds ?? 0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(recording.durationSeconds ?? 0);
  const [cropRect, setCropRect] = useState<CropRect>(IDENTITY_CROP_RECT);

  const [isSaving, setIsSaving] = useState(false);
  const [saveProgress, setSaveProgress] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Fetches the recording's bytes once, in CORS mode, on mount -- see this
  // file's own module comment. Video keeps the Blob around for mediabunny;
  // photo keeps the decoded HTMLImageElement around for the crop canvas.
  useEffect(() => {
    let cancelled = false;
    let ownBlobUrl: string | null = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on a prop-driven dependency change (recording.id), same pattern as CameraCapturePage's own camera-acquisition effect
    setIsLoading(true);
    setLoadError(null);

    if (recording.kind === "video") {
      fetch(recording.url, { mode: "cors" })
        .then((res) => {
          if (!res.ok) throw new Error(`Could not fetch this recording (HTTP ${res.status})`);
          return res.blob();
        })
        .then((blob) => {
          if (cancelled) return;
          ownBlobUrl = URL.createObjectURL(blob);
          setVideoBlob(blob);
          setPreviewUrl(ownBlobUrl);
          setIsLoading(false);
        })
        .catch((err) => {
          if (!cancelled) {
            setLoadError(err instanceof Error ? err.message : "Failed to load this recording");
            setIsLoading(false);
          }
        });
    } else {
      loadCrossOriginImage(recording.url)
        .then(({ image, blobUrl }) => {
          if (cancelled) {
            URL.revokeObjectURL(blobUrl);
            return;
          }
          ownBlobUrl = blobUrl;
          setImageElement(image);
          setPreviewUrl(blobUrl);
          setIsLoading(false);
        })
        .catch((err) => {
          if (!cancelled) {
            setLoadError(err instanceof Error ? err.message : "Failed to load this photo");
            setIsLoading(false);
          }
        });
    }

    return () => {
      cancelled = true;
      if (ownBlobUrl) URL.revokeObjectURL(ownBlobUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs only if a different recording is opened, same as ImageOverlayFramingDialog's own re-sync effect
  }, [recording.id]);

  function handleLoadedVideoMetadata(e: React.SyntheticEvent<HTMLVideoElement>) {
    const videoDuration = e.currentTarget.duration;
    if (!Number.isFinite(videoDuration) || videoDuration <= 0) return;
    setDurationSeconds(videoDuration);
    setTrimEnd((prev) => (prev > 0 ? Math.min(prev, videoDuration) : videoDuration));
  }

  async function handleSaveTrim() {
    if (!videoBlob) return;
    setIsSaving(true);
    setSaveError(null);
    setSaveProgress(0);
    try {
      const file = await trimToMp4Asset(videoBlob, { start: trimStart, end: trimEnd }, `${recording.name}.mp4`);
      const updated = await replaceRecordingContentWithProgress(
        recording.id,
        file,
        trimEnd - trimStart,
        setSaveProgress
      );
      onSave(updated);
    } catch (err) {
      setIsSaving(false);
      setSaveError(err instanceof Error ? err.message : "Failed to save this trim");
    }
  }

  async function handleSaveCrop() {
    if (!imageElement) return;
    setIsSaving(true);
    setSaveError(null);
    setSaveProgress(0);
    try {
      const sx = cropRect.x * imageElement.naturalWidth;
      const sy = cropRect.y * imageElement.naturalHeight;
      const sWidth = cropRect.width * imageElement.naturalWidth;
      const sHeight = cropRect.height * imageElement.naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sWidth));
      canvas.height = Math.max(1, Math.round(sHeight));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not create a canvas to crop this photo");
      ctx.drawImage(imageElement, sx, sy, sWidth, sHeight, 0, 0, canvas.width, canvas.height);
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      if (!blob) throw new Error("Could not crop this photo");
      const file = new File([blob], `${recording.name}.jpg`, { type: "image/jpeg" });
      const updated = await replaceRecordingContentWithProgress(recording.id, file, null, setSaveProgress);
      onSave(updated);
    } catch (err) {
      setIsSaving(false);
      setSaveError(err instanceof Error ? err.message : "Failed to save this crop");
    }
  }

  const isVideo = recording.kind === "video";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isVideo ? "Trim recording" : "Crop photo"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-md flex-col gap-3 rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{isVideo ? "Trim recording" : "Crop photo"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        {isLoading && <p className="py-8 text-center text-sm text-muted">Loading…</p>}
        {loadError && <p className="text-sm text-red-600">{loadError}</p>}

        {!isLoading && !loadError && isVideo && previewUrl && (
          <>
            <video
              src={previewUrl}
              controls
              onLoadedMetadata={handleLoadedVideoMetadata}
              className="max-h-[50vh] w-full rounded-md bg-black"
            />
            <RangeTrimBar
              durationSeconds={durationSeconds}
              start={trimStart}
              end={trimEnd}
              onChange={({ start, end }) => {
                setTrimStart(start);
                setTrimEnd(end);
              }}
            />
            <p className="text-center text-xs text-muted">
              {formatTime(trimStart)} – {formatTime(trimEnd)} (of {formatTime(durationSeconds)})
            </p>
          </>
        )}

        {!isLoading && !loadError && !isVideo && previewUrl && (
          <div className="relative aspect-[9/16] w-full overflow-hidden rounded-md bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local blob: URL, not a Next-optimizable static asset */}
            <img src={previewUrl} alt={recording.name} className="h-full w-full object-cover" />
            <CropRectOverlay cropRect={cropRect} onChange={setCropRect} onCommit={setCropRect} />
          </div>
        )}

        {saveError && <p className="text-xs text-red-600">{saveError}</p>}
        {isSaving && <p className="text-xs text-muted">Saving… {Math.round(saveProgress * 100)}%</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-background disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void (isVideo ? handleSaveTrim() : handleSaveCrop())}
            disabled={isSaving || isLoading || Boolean(loadError)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
