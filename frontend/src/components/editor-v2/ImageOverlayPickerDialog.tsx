"use client";

/**
 * "Image Overlay" tab's own small asset-picker -- structural twin of
 * VideoOverlayPickerDialog.tsx (see that file's own module comment for the
 * two-step select-then-confirm flow and the "Already on this reel" list's
 * own rationale), minus the video-thumbnail indirection: an image asset's
 * own `url` IS its thumbnail, no extraction needed.
 */
import { useState } from "react";
import type { Asset } from "@/lib/api";
import { useCrossOriginImageSrcMap } from "@/lib/useCrossOriginImageSrc";
import { describeOverlayLayout, formatTimeRange, type ImageOverlayClip } from "@/lib/video/video_math";

export function ImageOverlayPickerDialog({
  assets,
  overlayImages,
  videoDurationSeconds,
  onPick,
  onLocateOverlay,
  onClose,
}: {
  assets: Asset[];
  // Every image overlay already placed on this reel -- see
  // VideoOverlayPickerDialog.tsx's own module comment for why they're
  // listed here.
  overlayImages: ImageOverlayClip[];
  videoDurationSeconds: number;
  onPick: (asset: Asset) => void;
  // A row's own click, in the "Already on this reel" list -- seeks the
  // live preview to that overlay's start and closes this dialog.
  onLocateOverlay: (overlayIndex: number) => void;
  onClose: () => void;
}) {
  const imageAssets = assets.filter((asset) => asset.kind === "image");
  // Must never load asset.url via a plain <img> -- see
  // useCrossOriginImageSrcMap's own comment for why that can poison the
  // browser's cache against CanvasPlayer's later CORS-mode fetch of the
  // exact same URL for the live preview.
  const imageSrcById = useCrossOriginImageSrcMap(imageAssets.map((asset) => ({ id: asset.id, url: asset.url })));
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  function handleConfirm() {
    const asset = imageAssets.find((candidate) => candidate.id === selectedAssetId);
    if (!asset) return;
    onPick(asset);
    onClose();
  }

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
          <div className="grid max-h-[40vh] grid-cols-4 gap-2 overflow-y-auto">
            {imageAssets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                title={asset.filename}
                onClick={() => setSelectedAssetId(asset.id)}
                className={
                  "aspect-square overflow-hidden rounded-md border-2 " +
                  (selectedAssetId === asset.id ? "border-accent" : "border-transparent hover:border-sky-500")
                }
              >
                {imageSrcById[asset.id] && (
                  // eslint-disable-next-line @next/next/no-img-element -- a blob: URL from a safe CORS-mode fetch, not a Next-optimizable static asset
                  <img src={imageSrcById[asset.id]} alt={asset.filename} className="h-full w-full object-cover" />
                )}
              </button>
            ))}
          </div>
        )}

        <div className="mt-3 flex justify-end gap-2">
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

        {overlayImages.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <h3 className="mb-1.5 text-xs font-medium text-foreground">Already on this reel</h3>
            <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
              {overlayImages.map((overlay, index) => {
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
                      {imageSrcById[overlay.assetId] ? (
                        // eslint-disable-next-line @next/next/no-img-element -- a blob: URL from a safe CORS-mode fetch, not a Next-optimizable static asset
                        <img src={imageSrcById[overlay.assetId]} alt="" className="h-6 w-6 shrink-0 rounded-sm object-cover" />
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
