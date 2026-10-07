"use client";

/**
 * "Overlay" tab's asset-picker -- one dialog for both photos and videos, the
 * same way "Cutaway" is one button for either. It replaces the separate
 * "Video Overlay" and "Image Overlay" pickers; the two kinds still become
 * different clips underneath (VideoOverlayClip / ImageOverlayClip, each on
 * its own rail), so which handler runs is decided by the picked asset's kind.
 *
 * Two-step select-then-confirm (pick a tile, then "Add overlay"/Cancel), so
 * the "Already on this reel" list below has a Cancel that can back out of an
 * accidental tile click without needing an undo.
 *
 * That list is the other point of this dialog: overlays have no summary
 * anywhere else reachable from the place you'd add another one, and their
 * on-timeline position is easy to lose track of -- an overlay's own rail row
 * shows only its shape, not its absolute time, and isn't clamped to the
 * video's current length (a clip resize/delete upstream can leave one sitting
 * past the end with no visible cue). Each row shows its start-end range in
 * plain text, flags one past the video's current length, and clicking a row
 * seeks the live preview there and closes this dialog.
 *
 * Background removal (none / chroma key / AI) only applies to a video, so
 * those controls appear only while a video tile is the selected one.
 */
import { useState } from "react";
import type { Asset } from "@/lib/api";
import { useCrossOriginImageSrcMap } from "@/lib/useCrossOriginImageSrc";
import { describeOverlayLayout, formatTimeRange, type ImageOverlayClip, type VideoOverlayClip } from "@/lib/video/video_math";
import { CHROMA_KEY_PRESETS, DEFAULT_CHROMA_KEY_COLOR } from "@/lib/video/chromaKey";

type RemovalMode = "none" | "chromaKey" | "ai";
export type OverlayKind = "video" | "image";

export function OverlayPickerDialog({
  assets,
  videoThumbnailUrlByAssetId,
  videoOverlays,
  overlayImages,
  videoDurationSeconds,
  preselectedAssetId,
  onPickVideo,
  onPickImage,
  onLocateOverlay,
  onDeleteOverlay,
  onClose,
}: {
  assets: Asset[];
  // AssetGallery's own extracted per-video representative still frame -- a
  // video asset's own `url` points at the video FILE, not an image, so this is
  // what renders in a video tile (see ThreePaneEditor's videoThumbnailUrlByAssetId).
  videoThumbnailUrlByAssetId: Record<string, string>;
  videoOverlays: VideoOverlayClip[];
  overlayImages: ImageOverlayClip[];
  videoDurationSeconds: number;
  // Set when opened from AssetGallery's right-click "Overlay" on a specific
  // video tile -- pre-selects it instead of requiring a second click.
  preselectedAssetId?: string | null;
  onPickVideo: (asset: Asset, options?: { removeBackground?: boolean; chromaKeyColor?: string }) => void;
  onPickImage: (asset: Asset) => void;
  // A row's own click, in the "Already on this reel" list -- seeks the live
  // preview to that overlay's start and closes this dialog.
  onLocateOverlay: (kind: OverlayKind, overlayIndex: number) => void;
  // A row's own delete (✕) button -- removes that overlay outright, same as
  // the rail's own right-click "Remove overlay", reachable here since the rail
  // isn't visible while this modal is open.
  onDeleteOverlay: (kind: OverlayKind, overlayIndex: number) => void;
  onClose: () => void;
}) {
  const pickableAssets = assets.filter((asset) => asset.kind === "video" || asset.kind === "image");
  const imageAssets = pickableAssets.filter((asset) => asset.kind === "image");
  // Must never load an image asset's url via a plain <img> -- see
  // useCrossOriginImageSrcMap's own comment for why that can poison the
  // browser's cache against CanvasPlayer's later CORS-mode fetch of the same URL.
  const imageSrcById = useCrossOriginImageSrcMap(imageAssets.map((asset) => ({ id: asset.id, url: asset.url })));
  // Applies to whichever video tile ends up confirmed -- one choice for the
  // whole picker. "Chroma key" is instant, local and free (never calls fal.ai,
  // in preview or the final render -- see lib/video/chromaKey.ts) but needs a
  // real solid-colour screen; "AI removal" is the fal.ai/VEED job, any
  // backdrop, requested right away.
  const [removalMode, setRemovalMode] = useState<RemovalMode>("none");
  const [chromaKeyColor, setChromaKeyColor] = useState(DEFAULT_CHROMA_KEY_COLOR);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(preselectedAssetId ?? null);

  const selectedAsset = pickableAssets.find((asset) => asset.id === selectedAssetId) ?? null;

  function thumbnailFor(assetId: string): string | undefined {
    return imageSrcById[assetId] ?? videoThumbnailUrlByAssetId[assetId];
  }

  function handleConfirm() {
    if (!selectedAsset) return;
    if (selectedAsset.kind === "video") {
      onPickVideo(selectedAsset, {
        removeBackground: removalMode === "ai",
        chromaKeyColor: removalMode === "chromaKey" ? chromaKeyColor : undefined,
      });
    } else {
      onPickImage(selectedAsset);
    }
    onClose();
  }

  const placed = [
    ...videoOverlays.map((overlay, index) => ({ kind: "video" as const, index, overlay })),
    ...overlayImages.map((overlay, index) => ({ kind: "image" as const, index, overlay })),
  ].sort((a, b) => a.overlay.startTimeSeconds - b.overlay.startTimeSeconds);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Overlay"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div onClick={(e) => e.stopPropagation()} className="flex w-full max-w-lg flex-col rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Overlay -- choose a video or photo</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="mb-2 text-[11px] text-muted">
          Places it at the current playhead -- a video defaults to Full-Screen, a photo to a small movable box. Switch layout
          afterward on its own rail.
        </p>
        {pickableAssets.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted">No videos or photos in this project yet</p>
        ) : (
          <div className="grid max-h-[40vh] grid-cols-4 gap-2 overflow-y-auto">
            {pickableAssets.map((asset) => {
              const thumbnail = thumbnailFor(asset.id);
              return (
                <button
                  key={asset.id}
                  type="button"
                  title={asset.filename}
                  onClick={() => setSelectedAssetId(asset.id)}
                  className={
                    "relative aspect-square overflow-hidden rounded-md border-2 bg-neutral-800 " +
                    (selectedAssetId === asset.id ? "border-accent" : "border-transparent hover:border-amber-500")
                  }
                >
                  {thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a blob: URL from a safe CORS-mode fetch, or a captured video-frame data URL; not Next-optimizable static assets
                    <img src={thumbnail} alt={asset.filename} className="h-full w-full object-cover" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-xs text-muted">
                      {asset.kind === "video" ? "▶" : ""}
                    </span>
                  )}
                  {asset.kind === "video" && (
                    <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[9px] leading-tight text-white">
                      ▶ video
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {selectedAsset?.kind === "video" && (
          <div className="mt-3 flex flex-col gap-2">
            <div className="flex items-center gap-3 text-xs text-muted">
              <span className="font-medium text-foreground">Background:</span>
              <label className="flex items-center gap-1">
                <input type="radio" name="overlay-removal-mode" checked={removalMode === "none"} onChange={() => setRemovalMode("none")} />
                None
              </label>
              <label className="flex items-center gap-1" title="Instant and free, entirely on your device -- for a real solid-color green/blue screen.">
                <input type="radio" name="overlay-removal-mode" checked={removalMode === "chromaKey"} onChange={() => setRemovalMode("chromaKey")} />
                Chroma key
              </label>
              <label className="flex items-center gap-1" title="AI background removal for any backdrop -- calls fal.ai right away.">
                <input type="radio" name="overlay-removal-mode" checked={removalMode === "ai"} onChange={() => setRemovalMode("ai")} />
                AI removal
              </label>
            </div>
            {removalMode === "chromaKey" && (
              <div className="flex items-center gap-2 pl-1">
                <span className="text-[11px] text-muted">Screen color:</span>
                {CHROMA_KEY_PRESETS.map((preset) => (
                  <button
                    key={preset.hex}
                    type="button"
                    title={preset.label}
                    onClick={() => setChromaKeyColor(preset.hex)}
                    className={"h-5 w-5 rounded-full border-2 " + (chromaKeyColor === preset.hex ? "border-accent" : "border-transparent")}
                    style={{ backgroundColor: preset.hex }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border py-1.5 px-3 text-sm font-medium text-foreground hover:bg-background"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selectedAsset}
            onClick={handleConfirm}
            className="rounded-md bg-accent py-1.5 px-3 text-sm font-medium text-accent-foreground disabled:opacity-50"
          >
            Add overlay
          </button>
        </div>

        {placed.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <h3 className="mb-1.5 text-xs font-medium text-foreground">Already on this reel</h3>
            <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
              {placed.map(({ kind, index, overlay }) => {
                const pastEnd = overlay.endTimeSeconds > videoDurationSeconds;
                const thumbnail = thumbnailFor(overlay.assetId);
                return (
                  <li key={`${kind}-${index}`} className="flex items-center gap-1 rounded-md hover:bg-background">
                    <button
                      type="button"
                      onClick={() => {
                        onLocateOverlay(kind, index);
                        onClose();
                      }}
                      title="Jump the preview to this overlay"
                      className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left text-xs"
                    >
                      {thumbnail ? (
                        // eslint-disable-next-line @next/next/no-img-element -- see the tile grid above
                        <img src={thumbnail} alt="" className="h-6 w-6 shrink-0 rounded-sm object-cover" />
                      ) : (
                        <span className="h-6 w-6 shrink-0 rounded-sm bg-neutral-800" />
                      )}
                      <span className="shrink-0 text-muted">{kind === "video" ? "Video" : "Photo"}</span>
                      <span className="min-w-0 flex-1 truncate text-foreground">{describeOverlayLayout(overlay.layout)}</span>
                      <span className="shrink-0 text-muted">{formatTimeRange(overlay.startTimeSeconds, overlay.endTimeSeconds)}</span>
                      {pastEnd && (
                        <span title="Starts or ends after the video's current length -- won't show on the timeline until you scroll past it" className="shrink-0 text-amber-600">
                          ⚠ past end
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteOverlay(kind, index)}
                      aria-label="Remove this overlay"
                      title="Remove this overlay"
                      className="shrink-0 rounded-sm p-1 mr-1 text-muted hover:text-red-600"
                    >
                      ✕
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
