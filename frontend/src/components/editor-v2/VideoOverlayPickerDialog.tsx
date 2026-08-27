"use client";

/**
 * "Video Overlay" tab's own small asset-picker -- the tab's whole point is
 * making the "Overlay" action genuinely reachable from the vertical panel,
 * not just relocated in name, so this needs to actually let you pick WHICH
 * video becomes the overlay rather than only showing a status badge.
 * Picking a tile instantly adds it (same Full-Screen-default, current-
 * playhead placement as AssetGallery's right-click "Overlay" -- see
 * ThreePaneEditor's handleAddVideoOverlay) and this dialog closes itself;
 * there's nothing else to configure here, everything else (layout, framing)
 * happens afterward on the rail itself.
 */
import type { Asset } from "@/lib/api";

export function VideoOverlayPickerDialog({
  assets,
  videoThumbnailUrlByAssetId,
  onPick,
  onClose,
}: {
  assets: Asset[];
  // AssetGallery's own extracted per-video representative still frame --
  // a video asset's own `url` points at the video FILE, not an image, so
  // this is what actually renders in each tile (see ThreePaneEditor's own
  // videoThumbnailUrlByAssetId state comment).
  videoThumbnailUrlByAssetId: Record<string, string>;
  onPick: (asset: Asset) => void;
  onClose: () => void;
}) {
  const videoAssets = assets.filter((asset) => asset.kind === "video");

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
          <div className="grid max-h-[60vh] grid-cols-4 gap-2 overflow-y-auto">
            {videoAssets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                title={asset.filename}
                onClick={() => onPick(asset)}
                className="aspect-square overflow-hidden rounded-md border-2 border-transparent bg-neutral-800 hover:border-amber-500"
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
      </div>
    </div>
  );
}
