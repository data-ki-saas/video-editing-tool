"use client";

/**
 * "Video Overlay" tab's own small asset-picker. Two-step select-then-
 * confirm (pick a tile, then "Add overlay"/Cancel) -- unlike this dialog's
 * original single-click-instantly-adds flow, matching CutawayDialog's own
 * pattern instead, since a picker offering a list of what's ALREADY placed
 * (see below) needs a Cancel that can back out of an accidental tile click
 * without also having to immediately undo an add.
 *
 * The "Already on this reel" list is the actual point of this dialog now,
 * not just the picker grid: video overlays have no dedicated summary
 * anywhere else that's reachable from the SAME place you'd go to add
 * another one, and their on-timeline position is easy to lose track of --
 * an overlay's own row (VideoOverlayTrack) shows only its shape, not its
 * absolute time, and isn't clamped to the video's current length (a clip
 * resize/delete upstream of it can leave it sitting past the end with no
 * visible cue at all). Each row here shows its actual start-end time
 * range in plain text, flagging one that now falls past the video's
 * current length -- exactly the case that's otherwise invisible -- and
 * clicking a row seeks the live preview there and closes this dialog, the
 * same "jump to it" a marker or clip boundary already gives you elsewhere.
 */
import { useState } from "react";
import type { Asset } from "@/lib/api";
import { describeOverlayLayout, formatTimeRange, type VideoOverlayClip } from "@/lib/video/video_math";

export function VideoOverlayPickerDialog({
  assets,
  videoThumbnailUrlByAssetId,
  videoOverlays,
  videoDurationSeconds,
  onPick,
  onLocateOverlay,
  onClose,
}: {
  assets: Asset[];
  // AssetGallery's own extracted per-video representative still frame --
  // a video asset's own `url` points at the video FILE, not an image, so
  // this is what actually renders in each tile (see ThreePaneEditor's own
  // videoThumbnailUrlByAssetId state comment).
  videoThumbnailUrlByAssetId: Record<string, string>;
  // Every video overlay already placed on this reel -- see this file's own
  // module comment for why they're listed here.
  videoOverlays: VideoOverlayClip[];
  videoDurationSeconds: number;
  onPick: (asset: Asset, options?: { removeBackground?: boolean }) => void;
  // A row's own click, in the "Already on this reel" list -- seeks the
  // live preview to that overlay's start and closes this dialog.
  onLocateOverlay: (overlayIndex: number) => void;
  onClose: () => void;
}) {
  const videoAssets = assets.filter((asset) => asset.kind === "video");
  // Applies to whichever tile ends up confirmed via "Add overlay" below --
  // a single flag for the whole picker, not per-tile, same as before.
  const [removeBackground, setRemoveBackground] = useState(false);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  function handleConfirm() {
    const asset = videoAssets.find((candidate) => candidate.id === selectedAssetId);
    if (!asset) return;
    onPick(asset, { removeBackground });
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Video Overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="flex w-full max-w-lg flex-col rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Video Overlay -- choose a video</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="mb-2 text-[11px] text-muted">
          Places it at the current playhead, defaulting to Full-Screen -- switch layout afterward on its own rail.
        </p>
        {videoAssets.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">No videos in this project yet</p>
        ) : (
          <div className="grid max-h-[40vh] grid-cols-4 gap-2 overflow-y-auto">
            {videoAssets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                title={asset.filename}
                onClick={() => setSelectedAssetId(asset.id)}
                className={
                  "aspect-square overflow-hidden rounded-md border-2 bg-neutral-800 " +
                  (selectedAssetId === asset.id ? "border-accent" : "border-transparent hover:border-amber-500")
                }
              >
                {videoThumbnailUrlByAssetId[asset.id] ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a captured video-frame data URL, not a Next-optimizable static asset
                  <img src={videoThumbnailUrlByAssetId[asset.id]} alt={asset.filename} className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center text-xs text-muted">▶</span>
                )}
              </button>
            ))}
          </div>
        )}

        <div className="mt-3 flex items-center justify-between gap-2">
          {/* AI background removal -- same one-shot toggle as CutawayDialog's
              own "Remove background" checkbox, see that component's comment.
              Applied to whichever tile is confirmed via "Add overlay". */}
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={removeBackground}
              onChange={(e) => setRemoveBackground(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Remove background (e.g. green screen)
          </label>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-border py-1.5 px-3 text-sm font-medium text-foreground hover:bg-background"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!selectedAssetId}
              onClick={handleConfirm}
              className="rounded-md bg-accent py-1.5 px-3 text-sm font-medium text-accent-foreground disabled:opacity-50"
            >
              Add overlay
            </button>
          </div>
        </div>

        {videoOverlays.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <h3 className="mb-1.5 text-xs font-medium text-foreground">Already on this reel</h3>
            <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
              {videoOverlays.map((overlay, index) => {
                const pastEnd = overlay.endTimeSeconds > videoDurationSeconds;
                return (
                  <li key={index}>
                    <button
                      type="button"
                      onClick={() => {
                        onLocateOverlay(index);
                        onClose();
                      }}
                      title="Jump the preview to this overlay"
                      className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-background"
                    >
                      {videoThumbnailUrlByAssetId[overlay.assetId] ? (
                        // eslint-disable-next-line @next/next/no-img-element -- reuses AssetGallery's own extracted video-tile thumbnail, not a Next-optimizable static asset
                        <img
                          src={videoThumbnailUrlByAssetId[overlay.assetId]}
                          alt=""
                          className="h-6 w-6 shrink-0 rounded-sm object-cover"
                        />
                      ) : (
                        <span className="h-6 w-6 shrink-0 rounded-sm bg-neutral-800" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-foreground">{describeOverlayLayout(overlay.layout)}</span>
                      <span className="shrink-0 text-muted">{formatTimeRange(overlay.startTimeSeconds, overlay.endTimeSeconds)}</span>
                      {pastEnd && (
                        <span title="Starts or ends after the video's current length -- won't show on the timeline until you scroll past it" className="shrink-0 text-amber-600">
                          ⚠ past end
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
