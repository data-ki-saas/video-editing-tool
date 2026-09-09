"use client";

/**
 * AssetGallery's right-click "View" -- plays a video full-size or shows a
 * larger image for an asset already in the project, the same "check it
 * before you act on it" idea as StockPreviewPopup but for a real project
 * Asset (whose url is a private, presigned R2 URL) rather than a stock
 * search result's public preview URL. That difference matters: this must
 * go through the cross-origin blob hooks, never a plain <video src>/<img
 * src> against asset.url directly -- see useCrossOriginVideoSrc/
 * useCrossOriginImageSrc's own comments for why that would poison the
 * browser's cache against CanvasPlayer's later CORS-mode fetch of the
 * identical URL.
 */
import type { Asset } from "@/lib/api";
import { useCrossOriginImageSrc } from "@/lib/useCrossOriginImageSrc";
import { useCrossOriginVideoSrc } from "@/lib/useCrossOriginVideoSrc";
import { ReelLoader } from "@/components/ReelLoader";

export function AssetPreviewPopup({ asset, onClose }: { asset: Asset; onClose: () => void }) {
  const videoSrc = useCrossOriginVideoSrc(asset.kind === "video" ? asset.url : null);
  const imageSrc = useCrossOriginImageSrc(asset.kind === "image" ? asset.url : null);
  const src = asset.kind === "video" ? videoSrc : imageSrc;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${asset.filename}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="truncate text-sm font-semibold" title={asset.filename}>
            {asset.filename}
          </h3>
          <button type="button" onClick={onClose} aria-label="Close preview" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-md bg-black">
          {!src ? (
            <ReelLoader stage="Loading preview…" />
          ) : asset.kind === "video" ? (
            <video src={src} controls autoPlay className="max-h-[60vh] w-full" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- a same-origin blob: URL (useCrossOriginImageSrc), not a Next-optimizable static asset
            <img src={src} alt={asset.filename} className="max-h-[60vh] w-full object-contain" />
          )}
        </div>
      </div>
    </div>
  );
}
