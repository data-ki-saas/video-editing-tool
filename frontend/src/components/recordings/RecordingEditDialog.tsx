"use client";

/**
 * Popup editor for one recording -- trim (video) or crop (photo), Save
 * overwrites it in place (same id/name/description, underlying file
 * replaced). Modal chrome copied from editor-v2/UploadDialog.tsx.
 *
 * The video branch deliberately reuses the MAIN editor's own trim widgets
 * rather than a bespoke one: editor-v2/TrimTrack.tsx (unchanged, zero asset
 * coupling -- see its own doc comment) for laying out cuts, plus a thumbnail
 * filmstrip built from the same lib/video/video.ts's extractThumbnails the
 * main editor's own frame strip uses. The click-to-drop-a-dot/click-again-
 * to-cut state machine below is TrimTrack's own contract (see
 * lib/video/transformations.ts's applyTrimTrackClick, which this mirrors
 * inline rather than importing -- that function is built around the whole
 * editor's EditSelectionsSnapshot, which this standalone dialog has no
 * reason to construct just to reuse three lines of logic). The live preview
 * skips over cut ranges during playback via lib/video/video_math.ts's own
 * skipTrimmedRanges -- the same pure function CanvasPlayer.tsx uses, just
 * driven off a plain <video>'s timeupdate event instead of that player's
 * audio-clock render loop. Save renders the kept (post-cut) ranges into a
 * real new mp4 via lib/media/recordingTrim.ts's exportTrimmedRecording,
 * which mirrors lib/localRender/exportTimeline.ts's own seek+draw recipe.
 *
 * Loads the recording's current bytes via a real CORS-mode fetch (see
 * lib/crossOriginImage.ts's own module comment on why a plain <video src>/
 * <img src> can't be trusted before a later pixel-level read -- a stray
 * no-cors load elsewhere can poison the browser's cache for this exact URL)
 * rather than pointing straight at the recording's presigned URL, since both
 * branches below need to read pixels/bytes back out (canvas for the photo
 * crop, mediabunny's BlobSource for the video export).
 */
import { useEffect, useRef, useState } from "react";
import { replaceRecordingContentWithProgress, type Recording } from "@/lib/api";
import { extractThumbnails } from "@/lib/video/video";
import { exportTrimmedRecording } from "@/lib/media/recordingTrim";
import { loadCrossOriginImage } from "@/lib/crossOriginImage";
import { CropRectOverlay } from "@/components/editor-v2/CropRectOverlay";
import { TrimTrack } from "@/components/editor-v2/TrimTrack";
import { invertTrimRanges, mergeTrimRanges, skipTrimmedRanges, type CropRect, type TrimRange } from "@/lib/video/video_math";

const IDENTITY_CROP_RECT: CropRect = { x: 0, y: 0, width: 1, height: 1 };
// One thumbnail per second, same interval the main editor's own frame strip
// samples at (see ThreePaneEditor.tsx's THUMBNAIL_INTERVAL_SECONDS).
const THUMBNAIL_INTERVAL_SECONDS = 1;
// How close a click needs to land to the pending dot to cancel it instead of
// committing a near-zero-length cut -- same value as transformations.ts's
// own TRIM_CLICK_CANCEL_EPSILON_SECONDS.
const TRIM_CLICK_CANCEL_EPSILON_SECONDS = 0.15;

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [videoBlob, setVideoBlob] = useState<Blob | null>(null);
  const [imageElement, setImageElement] = useState<HTMLImageElement | null>(null);

  const [durationSeconds, setDurationSeconds] = useState(recording.durationSeconds ?? 0);
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [trimRanges, setTrimRanges] = useState<TrimRange[]>([]);
  const [pendingTrimStartSeconds, setPendingTrimStartSeconds] = useState<number | null>(null);
  const [cropRect, setCropRect] = useState<CropRect>(IDENTITY_CROP_RECT);

  const [isSaving, setIsSaving] = useState(false);
  const [saveStage, setSaveStage] = useState("");
  const [saveProgress, setSaveProgress] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isVideo = recording.kind === "video";

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

  // Builds the frame-strip thumbnails once the video's bytes are loaded --
  // best-effort (TrimTrack itself needs no thumbnails to function, just
  // videoDurationSeconds), so a failure here is silently ignored rather than
  // surfaced as a load error.
  useEffect(() => {
    if (!previewUrl || !isVideo) return;
    let cancelled = false;
    extractThumbnails(previewUrl, THUMBNAIL_INTERVAL_SECONDS)
      .then((frames) => {
        if (!cancelled) setThumbnails(frames);
      })
      .catch(() => {
        // Purely visual -- see this effect's own comment.
      });
    return () => {
      cancelled = true;
    };
  }, [previewUrl, isVideo]);

  function handleLoadedVideoMetadata(e: React.SyntheticEvent<HTMLVideoElement>) {
    const videoDuration = e.currentTarget.duration;
    if (Number.isFinite(videoDuration) && videoDuration > 0) setDurationSeconds(videoDuration);
  }

  // Live "preview the final result" -- jumps forward past a cut range the
  // instant playback (or a manual scrub) enters it, so hitting play shows
  // exactly what Save will produce. Same pure function CanvasPlayer.tsx
  // uses for the main timeline, just driven off a plain <video>'s own
  // timeupdate instead of that player's audio-clock loop (coarser, but
  // plenty for a popup preview -- see recordingTrim.ts's own module comment).
  function handleTimeUpdate(e: React.SyntheticEvent<HTMLVideoElement>) {
    const video = e.currentTarget;
    const adjusted = skipTrimmedRanges(trimRanges, video.currentTime);
    if (Math.abs(adjusted - video.currentTime) > 0.01) video.currentTime = adjusted;
  }

  // TrimTrack's own click contract (see this file's module comment): first
  // click drops a pending dot; a second click elsewhere commits the stretch
  // between them as a cut (merged into any existing overlapping/touching
  // ones); clicking back on the pending dot's own spot cancels it instead of
  // committing a near-zero-length cut.
  function handleTrimTrackClick(clickTimeSeconds: number) {
    if (pendingTrimStartSeconds === null) {
      setPendingTrimStartSeconds(clickTimeSeconds);
      return;
    }
    if (Math.abs(clickTimeSeconds - pendingTrimStartSeconds) < TRIM_CLICK_CANCEL_EPSILON_SECONDS) {
      setPendingTrimStartSeconds(null);
      return;
    }
    const startTimeSeconds = Math.min(pendingTrimStartSeconds, clickTimeSeconds);
    const endTimeSeconds = Math.max(pendingTrimStartSeconds, clickTimeSeconds);
    setTrimRanges((prev) => mergeTrimRanges([...prev, { startTimeSeconds, endTimeSeconds }]));
    setPendingTrimStartSeconds(null);
  }

  function handleDeleteTrimRange(rangeIndex: number) {
    setTrimRanges((prev) => prev.filter((_, i) => i !== rangeIndex));
  }

  async function handleSaveTrim() {
    if (!videoBlob) return;
    const keptRanges = invertTrimRanges(trimRanges, durationSeconds);
    setIsSaving(true);
    setSaveError(null);
    setSaveProgress(0);
    try {
      setSaveStage("Encoding…");
      const file = await exportTrimmedRecording(videoBlob, keptRanges, `${recording.name}.mp4`, (fraction) =>
        setSaveProgress(fraction)
      );
      setSaveStage("Uploading…");
      const keptDurationSeconds = keptRanges.reduce((sum, r) => sum + (r.endTimeSeconds - r.startTimeSeconds), 0);
      const updated = await replaceRecordingContentWithProgress(recording.id, file, keptDurationSeconds, setSaveProgress);
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
    setSaveStage("Uploading…");
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

  const keptDurationSeconds = trimRanges.length > 0
    ? invertTrimRanges(trimRanges, durationSeconds).reduce((sum, r) => sum + (r.endTimeSeconds - r.startTimeSeconds), 0)
    : durationSeconds;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isVideo ? "Trim recording" : "Crop photo"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-lg flex-col gap-3 rounded-lg bg-surface p-4 shadow-lg"
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
              ref={videoRef}
              src={previewUrl}
              controls
              playsInline
              onLoadedMetadata={handleLoadedVideoMetadata}
              onTimeUpdate={handleTimeUpdate}
              className="max-h-[45vh] w-full rounded-md bg-black"
            />

            <div className="flex flex-col gap-0.5">
              <TrimTrack
                trimRanges={trimRanges}
                pendingTrimStartSeconds={pendingTrimStartSeconds}
                videoDurationSeconds={durationSeconds}
                onClick={handleTrimTrackClick}
                onMoveDot={setPendingTrimStartSeconds}
                onDeleteRange={handleDeleteTrimRange}
              />
              <div className="flex h-12 w-full overflow-hidden rounded-sm bg-neutral-900">
                {thumbnails.map((thumbnail, index) => (
                  // eslint-disable-next-line @next/next/no-img-element -- a local data: URL frame capture, not a Next-optimizable static asset
                  <img key={index} src={thumbnail} alt="" className="h-full flex-1 object-cover" />
                ))}
              </div>
            </div>

            <p className="text-center text-xs text-muted">
              {trimRanges.length === 0
                ? "Click the strip above to start a cut, click again to close it -- right-click a cut to remove it."
                : `${trimRanges.length} cut${trimRanges.length === 1 ? "" : "s"} -- keeping ${formatTime(keptDurationSeconds)} of ${formatTime(durationSeconds)}`}
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
        {isSaving && (
          <p className="text-xs text-muted">
            {saveStage} {Math.round(saveProgress * 100)}%
          </p>
        )}

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
            disabled={isSaving || isLoading || Boolean(loadError) || (isVideo && trimRanges.length === 0)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
