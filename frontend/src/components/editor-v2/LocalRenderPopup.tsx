"use client";

/**
 * Shown while and after "Edge Render" (the free/local render) runs (see
 * lib/localRender/exportTimeline.ts, wired up in ThreePaneEditor.tsx's
 * handleLocalRenderClick) -- a loader while exporting, then the finished
 * video with native play/pause/seek controls plus an explicit Download
 * button (the blob URL only lives as long as this tab stays open, unlike
 * the cloud render's permanent R2 link, so downloading it is the only way
 * to keep it) and a "Save to library" button next to it (see
 * lib/api.ts's saveToLibrary) that uploads the SAME bytes to a permanent
 * public R2 object the /library page lists from then on. Same small-modal
 * chrome as StockPreviewPopup.tsx, dismissed only via the explicit ✕
 * button -- which itself only renders once isDismissable is true, since
 * there's nothing productive to do with this closed mid-render (the
 * render keeps running either way, and reopening it would risk a
 * confusing second click starting a second export).
 */
import { useRef, useState } from "react";
import { saveToLibrary } from "@/lib/api";
import { PostToYoutubeButton } from "@/components/PostToYoutubeButton";

type SaveState = "idle" | "saving" | "saved" | "error";

export function LocalRenderPopup({
  projectId,
  projectName,
  isRendering,
  progress,
  resultUrl,
  resultMimeType,
  resultError,
  resultWarnings,
  onClose,
}: {
  projectId: string;
  projectName: string;
  isRendering: boolean;
  progress: number;
  resultUrl: string | null;
  resultMimeType: string | null;
  resultError: string | null;
  resultWarnings: string[];
  onClose: () => void;
}) {
  const isDismissable = !isRendering;
  const fileExtension = resultMimeType === "video/webm" ? "webm" : "mp4";
  const videoRef = useRef<HTMLVideoElement>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedVideoId, setSavedVideoId] = useState<string | null>(null);

  // Captures whatever frame is currently on-screen (the video already
  // autoplays, so by the time someone clicks this it's well past the first
  // black/blank frame) rather than seeking to a specific timestamp first --
  // simple over exact, same "smart default over exposing a knob" call as
  // CoverPicker's own "frame" mode, just with no picker step at all here.
  function captureThumbnail(): Promise<Blob | null> {
    const videoEl = videoRef.current;
    if (!videoEl || videoEl.videoWidth === 0) return Promise.resolve(null);
    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return Promise.resolve(null);
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  }

  async function handleSaveToLibrary() {
    if (!resultUrl || saveState === "saving" || saveState === "saved") return;
    setSaveState("saving");
    setSaveError(null);
    try {
      // resultUrl is a same-tab blob: URL (see exportTimeline.ts) -- this
      // fetch is local, no network round trip, just recovers the Blob the
      // <video> element is already playing.
      const videoBlob = await fetch(resultUrl).then((res) => res.blob());
      const thumbnailBlob = await captureThumbnail();
      const rawDuration = videoRef.current?.duration;
      const saved = await saveToLibrary({
        projectId,
        video: videoBlob,
        videoFilename: `reel.${fileExtension}`,
        thumbnail: thumbnailBlob,
        durationSeconds: rawDuration != null && Number.isFinite(rawDuration) ? rawDuration : null,
      });
      setSavedVideoId(saved.id);
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      setSaveError(err instanceof Error ? err.message : "Failed to save to library");
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edge Render"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">Edge Render</h3>
          {isDismissable && (
            <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
              ✕
            </button>
          )}
        </div>

        {isRendering && (
          <div className="flex flex-col items-center gap-3 py-10">
            <svg viewBox="0 0 24 24" className="h-10 w-10 animate-spin text-accent" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="2.2" />
              <circle cx="12" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="16.8" cy="14.8" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="7.2" cy="14.8" r="1.4" fill="currentColor" stroke="none" />
            </svg>
            <p className="text-sm text-muted">Exporting… {Math.round(progress * 100)}%</p>
          </div>
        )}

        {!isRendering && resultError && (
          <p className="text-sm text-red-600">Edge Render failed: {resultError}</p>
        )}

        {!isRendering && resultUrl && (
          <div className="flex flex-col gap-3">
            <video
              ref={videoRef}
              src={resultUrl}
              controls
              autoPlay
              className="max-h-[60vh] w-full rounded-md bg-black"
            />
            {resultWarnings.length > 0 && (
              <ul className="flex flex-col gap-1 rounded-md bg-yellow-100 p-2 text-xs text-yellow-800">
                {resultWarnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <a
                href={resultUrl}
                download={`reel.${fileExtension}`}
                className="flex-1 rounded-md bg-accent py-1.5 text-center text-sm font-medium text-accent-foreground hover:opacity-90"
              >
                Download
              </a>
              <button
                type="button"
                onClick={handleSaveToLibrary}
                disabled={saveState === "saving" || saveState === "saved"}
                className="flex-1 rounded-md border border-border py-1.5 text-sm font-medium text-foreground hover:bg-background disabled:opacity-50"
              >
                {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved to library ✓" : "Save to library"}
              </button>
              {saveState === "saved" && savedVideoId && (
                <PostToYoutubeButton libraryVideoId={savedVideoId} title={projectName} />
              )}
            </div>
            {saveState === "error" && saveError && <p className="text-xs text-red-600">{saveError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
