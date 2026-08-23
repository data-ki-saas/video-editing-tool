"use client";

/**
 * Top band of the three-pane editor, left to right: the project switcher
 * (replaces the removed left navigation sidebar), this project's asset
 * gallery (replaces the always-visible upload dropzone -- "+ Asset" opens
 * UploadDialog instead), a background-track picker, the user-actions panel
 * (templates / clip rectangles / action buttons), and a play area showing
 * whichever asset is currently selected. The play area is playback-only --
 * no crop/flip editing happens here; that all lives on FrameStrip's
 * timeline (see Playground.tsx), CanvasPlayer just renders the result.
 */
import { useState } from "react";
import { ProjectList } from "./ProjectList";
import { AssetGallery } from "./AssetGallery";
import { UploadDialog } from "./UploadDialog";
import { StockMediaDialog } from "./StockMediaDialog";
import { BackgroundTrackSelector } from "./BackgroundTrackSelector";
import { UserActions } from "./UserActions";
import { CanvasPlayer, type CanvasPlayerHandle } from "./CanvasPlayer";
import { CLIP_RECT_OPTIONS } from "./ClipRectIcon";
import { CollapsiblePanel } from "./CollapsiblePanel";
import { MusicNoteIcon } from "@/components/icons/UIIcons";
import type { Asset } from "@/lib/api";
import type { CropRect, OverlayImage, TrimRange, ZoomEffect } from "@/lib/video/video_math";
import type { RefObject } from "react";

// Caps the play area to the widest ratio in the clip-rectangle catalogue
// (see ClipRectIcon.tsx) rather than letting it fill all remaining space --
// derived from that list, not hardcoded, so it stays correct if the
// catalogue changes.
const WIDEST_CLIP_RATIO = Math.max(...CLIP_RECT_OPTIONS.map((option) => option.widthRatio / option.heightRatio));

export function ActionArea({
  projectId,
  assets,
  assetsLoaded,
  selectedAsset,
  onSelectAsset,
  onUploaded,
  onUploadingChange,
  onAssetDeleted,
  onAddOverlay,
  onSetBackgroundTrack,
  usedAssetIds,
  selectedBackgroundTrackId,
  onSelectBackgroundTrack,
  selectedTemplateId,
  onSelectTemplate,
  selectedClipRectId,
  onSelectClipRect,
  baseCropRect,
  zoomEffects,
  liveCropRectOverride,
  flipHorizontalToggles,
  flipVerticalToggles,
  trimRanges,
  overlayImages,
  assetUrlById,
  onFrameDimensions,
  playerRef,
  onPlayerTimeUpdate,
}: {
  projectId: string;
  assets: Asset[];
  assetsLoaded: boolean;
  selectedAsset: Asset | null;
  onSelectAsset: (asset: Asset) => void;
  onUploaded: (asset: Asset) => void;
  onUploadingChange?: (isUploading: boolean) => void;
  onAssetDeleted: (assetId: string) => void;
  onAddOverlay: (asset: Asset) => void;
  onSetBackgroundTrack: (asset: Asset) => void;
  usedAssetIds: Set<string>;
  selectedBackgroundTrackId: string;
  onSelectBackgroundTrack: (id: string) => void;
  selectedTemplateId: string | null;
  onSelectTemplate: (id: string) => void;
  selectedClipRectId: string | null;
  onSelectClipRect: (id: string) => void;
  baseCropRect: CropRect | null;
  zoomEffects: ZoomEffect[];
  liveCropRectOverride: CropRect | null;
  flipHorizontalToggles: number[];
  flipVerticalToggles: number[];
  trimRanges: TrimRange[];
  overlayImages: OverlayImage[];
  assetUrlById: Record<string, string>;
  onFrameDimensions: (dimensions: { width: number; height: number }) => void;
  // Lets ThreePaneEditor's Playground scrub this player and track a
  // playhead against it -- see CanvasPlayer.tsx's seekTo/onTimeUpdate.
  playerRef: RefObject<CanvasPlayerHandle | null>;
  onPlayerTimeUpdate: (seconds: number) => void;
}) {
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isStockDialogOpen, setIsStockDialogOpen] = useState(false);

  return (
    <div className="flex h-full gap-4 overflow-x-auto p-4">
      <div className="w-40 shrink-0 overflow-hidden border-r border-border pr-4">
        <ProjectList activeProjectId={projectId} />
      </div>

      <div className="w-56 shrink-0 overflow-hidden border-r border-border pr-4">
        <AssetGallery
          assets={assets}
          isLoading={!assetsLoaded}
          selectedAssetId={selectedAsset?.id ?? null}
          onSelect={onSelectAsset}
          onAddAsset={() => setIsUploadDialogOpen(true)}
          onBrowseStock={() => setIsStockDialogOpen(true)}
          onDeleted={onAssetDeleted}
          onAddOverlay={onAddOverlay}
          onSetBackgroundTrack={onSetBackgroundTrack}
          usedAssetIds={usedAssetIds}
        />
      </div>

      <CollapsiblePanel label="Background track" icon={<MusicNoteIcon className="h-4 w-4" />} expandedClassName="w-40">
        <BackgroundTrackSelector selectedTrackId={selectedBackgroundTrackId} onSelectTrack={onSelectBackgroundTrack} />
      </CollapsiblePanel>

      <div className="w-[30rem] shrink-0 overflow-hidden border-r border-border pr-4">
        <UserActions
          selectedTemplateId={selectedTemplateId}
          onSelectTemplate={onSelectTemplate}
          selectedClipRectId={selectedClipRectId}
          onSelectClipRect={onSelectClipRect}
        />
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-end overflow-hidden rounded-md border border-border bg-neutral-950 p-2">
        <div className="h-full max-w-full" style={{ aspectRatio: `${WIDEST_CLIP_RATIO} / 1` }}>
          {selectedAsset?.kind === "video" ? (
            <CanvasPlayer
              key={selectedAsset.id}
              ref={playerRef}
              asset={selectedAsset}
              baseCropRect={baseCropRect}
              zoomEffects={zoomEffects}
              liveCropRectOverride={liveCropRectOverride}
              flipHorizontalToggles={flipHorizontalToggles}
              flipVerticalToggles={flipVerticalToggles}
              trimRanges={trimRanges}
              overlayImages={overlayImages}
              assetUrlById={assetUrlById}
              onFrameDimensions={onFrameDimensions}
              onTimeUpdate={onPlayerTimeUpdate}
            />
          ) : selectedAsset?.kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned URL, not a Next-optimizable static asset
            <img
              key={selectedAsset.id}
              src={selectedAsset.url}
              alt={selectedAsset.filename}
              className="h-full w-full object-contain"
            />
          ) : (
            <p className="flex h-full w-full items-center justify-center p-4 text-sm text-muted">
              Upload a video to start editing
            </p>
          )}
        </div>
      </div>

      {isUploadDialogOpen && (
        <UploadDialog
          projectId={projectId}
          onUploaded={(asset) => {
            onUploaded(asset);
            setIsUploadDialogOpen(false);
          }}
          onUploadingChange={onUploadingChange}
          onClose={() => setIsUploadDialogOpen(false)}
        />
      )}

      {isStockDialogOpen && (
        <StockMediaDialog
          projectId={projectId}
          onImported={onUploaded}
          onImportingChange={onUploadingChange}
          onClose={() => setIsStockDialogOpen(false)}
        />
      )}
    </div>
  );
}
