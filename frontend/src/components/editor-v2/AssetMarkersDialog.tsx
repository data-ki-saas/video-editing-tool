"use client";

/**
 * Popup for placing named markers into a SPECIFIC ASSET's own source
 * footage -- opened from a flag icon on a VideoOverlayTrack segment
 * (alongside its existing crosshair "Adjust framing" button). Unlike a
 * placement-scoped marker, these are stored keyed by assetId
 * (Timeline.assetMarkers, see projects.ts's TimelineMarker doc comment),
 * so they stay attached to the right moment in the footage even if this
 * clip is retrimmed, moved, or used as an overlay in more than one spot.
 *
 * Shows a per-second thumbnail strip of the asset's own full length
 * (extractThumbnails -- the SAME function FrameStrip uses for the main
 * sequence, just against a single asset instead of a concatenated one,
 * which is why the even-spacing assumption FrameStrip's own module comment
 * warns against for a multi-clip sequence is fine here) with a
 * MarkerTrack mounted below it at that same scale.
 */
import { useEffect, useState } from "react";
import { extractThumbnails, getVideoDuration } from "@/lib/video/video";
import { generateSampleTimestamps } from "@/lib/video/video_math";
import type { TimelineMarker } from "@/lib/projects";
import { MarkerTrack } from "./MarkerTrack";
import { ReelLoader } from "@/components/ReelLoader";

const THUMBNAIL_INTERVAL_SECONDS = 1;

export function AssetMarkersDialog({
  assetUrl,
  assetFilename,
  markers,
  onAdd,
  onMove,
  onRename,
  onDelete,
  onClose,
}: {
  assetUrl: string;
  assetFilename: string;
  markers: TimelineMarker[];
  onAdd: (timeSeconds: number) => void;
  onMove: (index: number, timeSeconds: number) => void;
  onRename: (index: number, label: string) => void;
  onDelete: (index: number) => void;
  onClose: () => void;
}) {
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting for a fresh load whenever assetUrl changes, same as ThreePaneEditor's own sequence-extraction effect
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

  return (
    <div role="dialog" aria-modal="true" aria-label="Clip markers" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="truncate text-sm font-semibold" title={assetFilename}>
            Markers -- {assetFilename}
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
                <MarkerTrack markers={markers} totalDurationSeconds={durationSeconds} onAdd={onAdd} onMove={onMove} onRename={onRename} onDelete={onDelete} />
              </div>
            </div>
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted">
          These markers stay attached to this clip&apos;s own footage, wherever it&apos;s used as an overlay.
        </p>
      </div>
    </div>
  );
}
