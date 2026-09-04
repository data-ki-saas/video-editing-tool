"use client";

/**
 * Popup for setting ONE overlay placement's own `sourceStartSeconds` --
 * opened from the flag icon on a VideoOverlayTrack segment (alongside its
 * existing crosshair "Adjust framing" button). Replaces the old
 * AssetMarkersDialog, which let you drop arbitrarily many named markers
 * into an asset's footage but never wired any of them back into anything
 * that actually played -- confirmed dead UI state. There is exactly ONE
 * marker here, and it means something real: where in the source footage
 * THIS overlay instance starts playing from. That, combined with the
 * source's own probed duration, is what VideoOverlayTrack.tsx's own
 * end-edge drag clamps against (one play-through from this point, no
 * further -- see its own module comment).
 *
 * Keeps its own local draft state and only commits on "Save" -- same
 * pattern as VideoOverlayFramingDialog/TextOverlayDialog, not a live/commit
 * split against the outer edit history. `sourceStartSeconds` lives on
 * `VideoOverlayClip` (undo-tracked via EditSelectionsSnapshot), so writing
 * on every drag pixel like the old cosmetic assetMarkers state did would
 * spam the undo stack.
 *
 * Shows a per-second thumbnail strip of the asset's own full length
 * (extractThumbnails -- the SAME function FrameStrip uses for the main
 * sequence, just against a single asset instead of a concatenated one)
 * with a MarkerTrack mounted below it at that same scale. MarkerTrack is
 * generic over an array of markers; here it's always fed exactly one, and
 * `onAdd`/`onMove` both just relocate that same one (there's nothing to
 * "add a second" of) -- rename/delete are wired to a no-op/reset since a
 * fixed single point can't meaningfully be renamed or removed.
 */
import { useEffect, useState } from "react";
import { extractThumbnails, getVideoDuration } from "@/lib/video/video";
import { generateSampleTimestamps, MIN_VIDEO_OVERLAY_DURATION_SECONDS, type VideoOverlayClip } from "@/lib/video/video_math";
import { MarkerTrack } from "./MarkerTrack";
import { ReelLoader } from "@/components/ReelLoader";

const THUMBNAIL_INTERVAL_SECONDS = 1;
const START_MARKER_LABEL = "Start";

export function OverlaySourceStartDialog({
  overlay,
  assetUrl,
  assetFilename,
  sourceDurationSeconds,
  onSave,
  onClose,
}: {
  overlay: VideoOverlayClip;
  assetUrl: string;
  assetFilename: string;
  sourceDurationSeconds: number; // Infinity if not yet probed
  onSave: (sourceStartSeconds: number) => void;
  onClose: () => void;
}) {
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draftSourceStartSeconds, setDraftSourceStartSeconds] = useState(overlay.sourceStartSeconds);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting for a fresh load whenever assetUrl changes, same as AssetMarkersDialog's own sequence-extraction effect used to
    setIsLoading(true);
    setError(null);
    setThumbnails([]);

    async function load() {
      const duration = await getVideoDuration(assetUrl);
      if (cancelled) return;
      setDurationSeconds(duration);
      const frames = await extractThumbnails(assetUrl, THUMBNAIL_INTERVAL_SECONDS, (framesSoFar) => {
        if (!cancelled) setThumbnails([...framesSoFar]);
      });
      if (!cancelled) setThumbnails(frames);
    }

    load()
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load this clip's thumbnails");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [assetUrl]);

  // Same timestamps extractThumbnails itself sampled at internally (same
  // interval, same probed duration) -- see this file's module comment.
  const thumbnailTimestampsSeconds = generateSampleTimestamps(durationSeconds, THUMBNAIL_INTERVAL_SECONDS);

  // Prefers this dialog's own freshly-probed duration once it resolves,
  // falling back to the caller's (possibly still-Infinity) value until then
  // -- keeps the clamp/remaining-time display correct even before this
  // dialog's own probe finishes.
  const effectiveSourceDurationSeconds = durationSeconds > 0 ? durationSeconds : sourceDurationSeconds;
  const hasKnownDuration = Number.isFinite(effectiveSourceDurationSeconds) && effectiveSourceDurationSeconds > 0;

  function clampSourceStart(timeSeconds: number): number {
    if (!hasKnownDuration) return Math.max(timeSeconds, 0);
    const maxStart = Math.max(effectiveSourceDurationSeconds - MIN_VIDEO_OVERLAY_DURATION_SECONDS, 0);
    return Math.min(Math.max(timeSeconds, 0), maxStart);
  }

  function handleSetSourceStart(timeSeconds: number) {
    setDraftSourceStartSeconds(clampSourceStart(timeSeconds));
  }

  function handleSave() {
    onSave(draftSourceStartSeconds);
  }

  const remainingSeconds = hasKnownDuration ? Math.max(effectiveSourceDurationSeconds - draftSourceStartSeconds, 0) : null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Overlay start point" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="truncate text-sm font-semibold" title={assetFilename}>
            Start point -- {assetFilename}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        {error && <p className="mb-3 text-xs text-red-600">{error}</p>}

        {isLoading && thumbnails.length === 0 ? (
          <ReelLoader stage="Loading clip…" className="p-0" />
        ) : (
          <div className="hide-scrollbar overflow-x-auto rounded-md bg-neutral-950">
            <div className="flex w-max flex-col">
              <div className="flex h-16">
                {thumbnails.map((src, index) => (
                  // eslint-disable-next-line @next/next/no-img-element -- short-lived data URLs, not a Next-optimizable remote image
                  <img
                    key={index}
                    src={src}
                    alt=""
                    title={`${(thumbnailTimestampsSeconds[index] ?? 0).toFixed(1)}s`}
                    className="h-full w-10 shrink-0 object-cover"
                  />
                ))}
              </div>
              <div style={{ width: thumbnails.length * 40 }}>
                <MarkerTrack
                  markers={[{ timeSeconds: draftSourceStartSeconds, label: START_MARKER_LABEL }]}
                  totalDurationSeconds={durationSeconds}
                  frameThumbnails={thumbnails}
                  frameThumbnailTimestampsSeconds={thumbnailTimestampsSeconds}
                  onAdd={handleSetSourceStart}
                  onMove={(_, timeSeconds) => handleSetSourceStart(timeSeconds)}
                  onRename={() => {}}
                  onDelete={() => setDraftSourceStartSeconds(0)}
                  onTogglePin={() => {}}
                />
              </div>
            </div>
          </div>
        )}

        <p className="mt-2 text-[11px] text-muted">
          {remainingSeconds !== null
            ? `This overlay plays from here for up to ${remainingSeconds.toFixed(1)}s before hitting the end of its source footage.`
            : "Drag the marker to where this overlay should start playing from its own source footage."}
        </p>

        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setDraftSourceStartSeconds(0)}
            className="text-xs text-muted hover:text-foreground hover:underline"
          >
            Reset
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-background">
              Cancel
            </button>
            <button type="button" onClick={handleSave} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground">
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
