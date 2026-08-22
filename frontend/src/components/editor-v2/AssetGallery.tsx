"use client";

/**
 * Thumbnail row of this project's uploaded assets, replacing the
 * always-visible upload dropzone from the original ActionArea design.
 * Clicking a tile selects that asset (drives the play area + Playground
 * timeline in ThreePaneEditor); "+ Asset" opens UploadDialog instead of a
 * permanent drop target taking up space; right-click offers Delete.
 */
import { useEffect, useState } from "react";
import { deleteAsset, type Asset } from "@/lib/api";
import { captureSingleFrame } from "@/lib/video/video";
import { ReelLoader } from "@/components/ReelLoader";
import { MusicNoteIcon } from "@/components/icons/UIIcons";
import { ContextMenu, useContextMenu } from "./ContextMenu";

export function AssetGallery({
  assets,
  isLoading,
  selectedAssetId,
  onSelect,
  onAddAsset,
  onBrowseStock,
  onDeleted,
}: {
  assets: Asset[];
  // Distinguishes "still fetching the list" from "fetched, there really
  // are none" -- showing "No assets yet" during the former read as a bug
  // (assets that clearly exist appearing to not exist, briefly).
  isLoading: boolean;
  selectedAssetId: string | null;
  onSelect: (asset: Asset) => void;
  onAddAsset: () => void;
  onBrowseStock: () => void;
  onDeleted: (assetId: string) => void;
}) {
  const [videoThumbnails, setVideoThumbnails] = useState<Record<string, string>>({});
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();

  // Generates one representative frame per video asset, once, the first
  // time it shows up here -- images use their own URL directly (no
  // extraction needed) and are skipped.
  useEffect(() => {
    let cancelled = false;
    for (const asset of assets) {
      if (asset.kind !== "video" || videoThumbnails[asset.id]) continue;
      captureSingleFrame(asset.url)
        .then((frame) => {
          if (!cancelled) setVideoThumbnails((prev) => ({ ...prev, [asset.id]: frame }));
        })
        .catch(() => {
          // Leaves this tile on the fallback icon below -- not worth
          // surfacing a gallery-thumbnail failure as a page-level error.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [assets, videoThumbnails]);

  async function handleDelete(asset: Asset) {
    if (!window.confirm(`Delete "${asset.filename}"? This can't be undone.`)) return;
    try {
      await deleteAsset(asset.id);
      onDeleted(asset.id);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete this asset");
    }
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">Your assets</h2>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={onBrowseStock} className="text-xs text-accent hover:underline">
            + Stock
          </button>
          <button type="button" onClick={onAddAsset} className="text-xs text-accent hover:underline">
            + Asset
          </button>
        </div>
      </div>

      <div className="flex flex-1 items-center gap-2 overflow-x-auto">
        {isLoading && assets.length === 0 && <ReelLoader stage="Loading assets…" className="p-0" />}
        {!isLoading && assets.length === 0 && <p className="self-center text-xs text-muted">No assets yet</p>}
        {assets.map((asset) => {
          const thumbnailSrc = asset.kind === "image" ? asset.url : videoThumbnails[asset.id];
          return (
            <button
              key={asset.id}
              type="button"
              title={asset.filename}
              onClick={() => onSelect(asset)}
              onContextMenu={(e) =>
                openContextMenu(e, [{ label: "Delete", danger: true, onSelect: () => void handleDelete(asset) }])
              }
              className={
                "relative h-full w-16 shrink-0 overflow-hidden rounded-md border-2 " +
                (selectedAssetId === asset.id ? "border-accent" : "border-transparent")
              }
            >
              {asset.kind === "audio" ? (
                <span className="flex h-full w-full items-center justify-center bg-neutral-800">
                  <MusicNoteIcon className="h-5 w-5 text-muted" />
                </span>
              ) : thumbnailSrc ? (
                // eslint-disable-next-line @next/next/no-img-element -- short-lived data:/presigned URL, not a Next-optimizable static asset
                <img src={thumbnailSrc} alt={asset.filename} className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center bg-neutral-800 text-xs text-muted">
                  {asset.kind === "video" ? "▶" : "🖼"}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}
