"use client";

/**
 * Touch-first replacement for AssetGallery's right-click asset actions --
 * see the mobile quick-create plan for why AssetGallery itself isn't reused
 * as-is (every action there -- "Add", "Cutaway", "Overlay" -- is a
 * right-click, with no touch equivalent). Three sections: the current
 * sequence as an ordered list (tap a clip to open its options, up/down
 * buttons to reorder -- not drag, deliberately, a whole new gesture-
 * precision surface for marginal benefit over two taps), background music
 * (if any), and this project's uploaded assets (tap a video/image to add it
 * to the sequence, tap audio to add it as background music).
 */
import { useState } from "react";
import type { Asset } from "@/lib/api";
import { UploadDialog } from "@/components/editor-v2/UploadDialog";
import { useCrossOriginImageSrcMap } from "@/lib/useCrossOriginImageSrc";
import type { SequenceEntry } from "@/lib/video/video_math";

export function MobileAssetStrip({
  projectId,
  assets,
  videoThumbnailUrlByAssetId,
  sequenceClips,
  backgroundAssetIds,
  onUploaded,
  onAddToSequence,
  onAddToBackground,
  onRemoveFromSequence,
  onMoveSequenceEntry,
  onRemoveFromBackground,
  onOpenClipMenu,
}: {
  projectId: string;
  assets: Asset[];
  videoThumbnailUrlByAssetId: Record<string, string>;
  sequenceClips: SequenceEntry[];
  backgroundAssetIds: string[];
  onUploaded: (asset: Asset) => void;
  onAddToSequence: (asset: Asset) => void;
  onAddToBackground: (asset: Asset) => void;
  onRemoveFromSequence: (entryId: string) => void;
  onMoveSequenceEntry: (entryId: string, direction: "earlier" | "later") => void;
  onRemoveFromBackground: (assetId: string) => void;
  onOpenClipMenu: (entry: SequenceEntry) => void;
}) {
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));

  // Image thumbnails must never load asset.url via a plain <img> -- see
  // useCrossOriginImageSrcMap's own comment for why that can poison the
  // browser's cache against CanvasPlayer's later CORS-mode fetch of the
  // exact same URL for the live preview.
  const imageThumbnailSrcById = useCrossOriginImageSrcMap(
    assets.filter((asset) => asset.kind === "image").map((asset) => ({ id: asset.id, url: asset.url }))
  );

  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Your reel</h2>
        <button
          type="button"
          onClick={() => setIsUploadOpen(true)}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground"
        >
          + Add media
        </button>
      </div>

      {sequenceClips.length === 0 ? (
        <p className="text-xs text-muted">Upload a video or photo below, then tap it to add it to your reel.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sequenceClips.map((entry, index) => {
            const asset = assetById.get(entry.assetId);
            // Must go through the CORS-safe blob map (built above), not
            // asset?.url directly -- same reason as imageThumbnailSrcById's
            // own comment: a plain <img> load of the raw presigned URL here
            // can poison the browser's cache against CanvasPlayer's later
            // CORS-mode fetch of that exact clip for the live preview.
            const thumbnailUrl = entry.kind === "image" ? imageThumbnailSrcById[entry.assetId] : videoThumbnailUrlByAssetId[entry.assetId];
            return (
              <li key={entry.id} className="flex items-center gap-2 rounded-md border border-border bg-surface p-2">
                <button type="button" onClick={() => onOpenClipMenu(entry)} className="flex flex-1 items-center gap-2 text-left">
                  <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-neutral-800">
                    {thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a CORS-safe blob: URL (image) or a captured video-frame data URL, not a Next-optimizable static asset
                      <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-xs text-muted">▶</span>
                    )}
                  </div>
                  <span className="truncate text-xs text-foreground">
                    {index + 1}. {asset?.filename ?? "Removed asset"}
                  </span>
                </button>
                <div className="flex shrink-0 flex-col gap-0.5">
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => onMoveSequenceEntry(entry.id, "earlier")}
                    aria-label="Move earlier"
                    className="h-6 w-6 rounded border border-border text-xs text-foreground disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={index === sequenceClips.length - 1}
                    onClick={() => onMoveSequenceEntry(entry.id, "later")}
                    aria-label="Move later"
                    className="h-6 w-6 rounded border border-border text-xs text-foreground disabled:opacity-30"
                  >
                    ↓
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveFromSequence(entry.id)}
                  aria-label="Remove clip"
                  className="shrink-0 text-muted hover:text-red-600"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {backgroundAssetIds.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold text-foreground">Background music</h3>
          <ul className="flex flex-col gap-1">
            {backgroundAssetIds.map((assetId) => (
              <li key={assetId} className="flex items-center justify-between rounded-md border border-border bg-surface px-2 py-1.5">
                <span className="truncate text-xs text-foreground">{assetById.get(assetId)?.filename ?? "Removed asset"}</span>
                <button type="button" onClick={() => onRemoveFromBackground(assetId)} className="text-muted hover:text-red-600">
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-semibold text-foreground">Your uploads</h3>
        {assets.length === 0 ? (
          <p className="text-xs text-muted">Nothing uploaded yet.</p>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {assets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                onClick={() => (asset.kind === "audio" ? onAddToBackground(asset) : onAddToSequence(asset))}
                title={asset.filename}
                className="aspect-square overflow-hidden rounded-md border border-border bg-neutral-800"
              >
                {asset.kind === "audio" ? (
                  <span className="flex h-full w-full items-center justify-center text-lg text-muted">🎵</span>
                ) : asset.kind === "image" && imageThumbnailSrcById[asset.id] ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a blob: URL from a safe CORS-mode fetch, not a Next-optimizable static asset
                  <img src={imageThumbnailSrcById[asset.id]} alt={asset.filename} className="h-full w-full object-cover" />
                ) : asset.kind === "image" ? (
                  <span className="flex h-full w-full items-center justify-center text-xs text-muted">🖼</span>
                ) : videoThumbnailUrlByAssetId[asset.id] ? (
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

      {isUploadOpen && (
        <UploadDialog
          projectId={projectId}
          onUploaded={(asset) => {
            onUploaded(asset);
            setIsUploadOpen(false);
          }}
          onClose={() => setIsUploadOpen(false)}
        />
      )}
    </div>
  );
}
