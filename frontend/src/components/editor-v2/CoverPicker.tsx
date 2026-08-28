"use client";

/**
 * Cover/thumbnail picker -- lets a creator choose which frame (or a custom
 * uploaded image) represents this reel on YouTube Shorts/TikTok/IG, instead
 * of leaving it to whatever frame each platform auto-picks.
 *
 * This does NOT set a poster embedded in the exported video -- rendering
 * here is 100% client-side (lib/localRender/exportTimeline.ts) and never
 * uploads anywhere, and mp4 posters aren't something these platforms read
 * anyway. Both actions below just produce a standalone public image the
 * user downloads and attaches during each platform's own "choose thumbnail"
 * step during publishing.
 *
 * "Use current frame" grabs the EXACT pixels already on screen via
 * CanvasPlayerHandle.captureFrame() -- not a fresh render -- so there's no
 * "is this accurate" question to answer; what the user sees is what gets
 * saved. "Upload image" is a plain file picker. Both are a single
 * synchronous request to the backend (see lib/api.ts's uploadThumbnail), so
 * there's no "pending, will update later" state to show.
 */
import { useRef, useState } from "react";
import type { RefObject } from "react";
import type { CanvasPlayerHandle } from "./CanvasPlayer";
import { uploadThumbnail, clearThumbnail } from "@/lib/api";
import { ReelLoader } from "@/components/ReelLoader";

export function CoverPicker({
  projectId,
  playerRef,
  currentTimeSeconds,
  thumbnailUrl,
  onSaved,
  onCleared,
  onClose,
}: {
  projectId: string;
  playerRef: RefObject<CanvasPlayerHandle | null>;
  currentTimeSeconds: number;
  thumbnailUrl: string | null;
  onSaved: (thumbnailUrl: string) => void;
  onCleared: () => void;
  onClose: () => void;
}) {
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleUseCurrentFrame() {
    setError(null);
    const blob = await playerRef.current?.captureFrame();
    if (!blob) {
      setError("Couldn't capture the current frame -- add a clip and try again.");
      return;
    }
    setIsBusy(true);
    try {
      const info = await uploadThumbnail(projectId, blob, "frame", currentTimeSeconds);
      onSaved(info.thumbnail_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save this frame as the cover");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleUploadImage(file: File) {
    setError(null);
    setIsBusy(true);
    try {
      const info = await uploadThumbnail(projectId, file, "upload");
      onSaved(info.thumbnail_url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload this image");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleReset() {
    setError(null);
    setIsBusy(true);
    try {
      await clearThumbnail(projectId);
      onCleared();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset the cover");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Cover"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Cover</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="mb-3 flex aspect-[9/16] w-full items-center justify-center overflow-hidden rounded-md bg-neutral-950">
          {thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a permanent R2 URL, not a Next-optimizable remote image worth configuring
            <img src={thumbnailUrl} alt="Current cover" className="h-full w-full object-cover" />
          ) : (
            <p className="p-4 text-center text-xs text-muted">
              No custom cover set yet -- YouTube/TikTok/IG will auto-pick a frame.
            </p>
          )}
        </div>

        {error && <p className="mb-3 text-xs text-red-600">{error}</p>}

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleUseCurrentFrame}
            disabled={isBusy}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isBusy ? <ReelLoader stage="Saving…" className="p-0" /> : "Use current frame"}
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void handleUploadImage(file);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isBusy}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-background disabled:cursor-not-allowed disabled:opacity-50"
          >
            Upload image
          </button>

          {thumbnailUrl && (
            <button
              type="button"
              onClick={handleReset}
              disabled={isBusy}
              className="text-xs text-muted hover:text-foreground hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              Reset to auto
            </button>
          )}
        </div>

        <p className="mt-3 text-[11px] text-muted">
          Download this image and attach it as your custom thumbnail when you publish.
        </p>
      </div>
    </div>
  );
}
