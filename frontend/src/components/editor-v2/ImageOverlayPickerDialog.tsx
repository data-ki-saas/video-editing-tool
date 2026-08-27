"use client";

/**
 * "Image Overlay" tab's own small asset-picker -- exact structural twin of
 * VideoOverlayPickerDialog.tsx (see that file's own module comment), minus
 * the video-thumbnail indirection: an image asset's own `url` IS its
 * thumbnail, no extraction needed. Picking a tile instantly adds it (same
 * Picture-in-Picture-default, current-playhead placement as AssetGallery's
 * right-click "Overlay" -- see ThreePaneEditor's handleAddImageOverlay) and
 * this dialog closes itself.
 */
import type { Asset } from "@/lib/api";

export function ImageOverlayPickerDialog({
  assets,
  onPick,
  onClose,
}: {
  assets: Asset[];
  onPick: (asset: Asset) => void;
  onClose: () => void;
}) {
  const imageAssets = assets.filter((asset) => asset.kind === "image");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image Overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="flex w-full max-w-lg flex-col rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Image Overlay -- choose a photo</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="mb-2 text-[11px] text-muted">
          Places it at the current playhead, defaulting to a small movable box -- switch layout afterward on its own rail.
        </p>
        {imageAssets.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">No photos in this project yet</p>
        ) : (
          <div className="grid max-h-[60vh] grid-cols-4 gap-2 overflow-y-auto">
            {imageAssets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                title={asset.filename}
                onClick={() => onPick(asset)}
                className="aspect-square overflow-hidden rounded-md border-2 border-transparent hover:border-sky-500"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned URL, not a Next-optimizable static asset */}
                <img src={asset.url} alt={asset.filename} className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
