"use client";

/**
 * Top band of the three-pane editor, left to right: the project switcher
 * (replaces the removed left navigation sidebar), this project's asset
 * gallery (replaces the always-visible upload dropzone -- "+ Asset" opens
 * UploadDialog instead), a background-track picker, the user-actions panel
 * (templates / clip rectangles / text), and a play area. The play area is
 * playback-only -- no crop/flip editing happens here; that all lives on
 * FrameStrip's timeline (see Playground.tsx), CanvasPlayer just renders
 * the result.
 *
 * The play area shows the video SEQUENCE (sequenceClips), not whichever
 * asset is merely highlighted in the gallery: a sequence with clips in it
 * always wins the play-area slot, falling back to a standalone image
 * preview or a placeholder only when the sequence is empty. Left-clicking
 * a video asset no longer has any effect on what plays -- only right-click
 * "Add" builds the sequence -- but still sets `selectedAsset` for the
 * gallery's own highlight border and for previewing an image asset
 * directly.
 */
import { useState } from "react";
import { ProjectList } from "./ProjectList";
import { AssetGallery } from "./AssetGallery";
import { UploadDialog } from "./UploadDialog";
import { StockMediaDialog } from "./StockMediaDialog";
import { BackgroundTrackSelector } from "./BackgroundTrackSelector";
import { UserActions } from "./UserActions";
import { TextOverlayDialog } from "./TextOverlayDialog";
import { CanvasPlayer, type CanvasPlayerHandle } from "./CanvasPlayer";
import { CLIP_RECT_OPTIONS } from "./ClipRectIcon";
import { CollapsiblePanel } from "./CollapsiblePanel";
import { MusicNoteIcon } from "@/components/icons/UIIcons";
import type { Asset } from "@/lib/api";
import type { CropRect, OverlayImage, TextOverlay, TrimRange, ZoomEffect } from "@/lib/video/video_math";
import type { TextTemplateId } from "@/lib/video/textTemplates";
import type { RefObject } from "react";

// Fallback play-area ratio before any clip rectangle has been picked yet --
// the widest one in the catalogue (see ClipRectIcon.tsx), derived from that
// list rather than hardcoded so it stays correct if the catalogue changes.
// Once a ratio IS selected, the play area is sized to THAT ratio exactly
// (see playAreaRatio below) rather than always this fallback -- sizing it
// to the widest ratio unconditionally meant a narrower/taller selection
// (e.g. a 9:16 portrait reel) sat inside a wider box than its own shape,
// which is exactly the "shouldn't stretch beyond the selected ratio"
// complaint this fixes.
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
  onAddToSequence,
  onAddToBackgroundSequence,
  usedAssetIds,
  selectedBackgroundTrackId,
  onSelectBackgroundTrack,
  selectedTemplateId,
  onSelectTemplate,
  selectedClipRectId,
  onSelectClipRect,
  onOpenTextDialog,
  isTextDialogOpen,
  editingTextOverlay,
  onSaveTextOverlay,
  onCloseTextDialog,
  previewFrameUrl,
  frameAspectRatio,
  baseCropRect,
  zoomEffects,
  liveCropRectOverride,
  flipHorizontalToggles,
  flipVerticalToggles,
  trimRanges,
  overlayImages,
  textOverlays,
  sequenceClips,
  backgroundTracks,
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
  onAddToSequence: (asset: Asset) => void;
  onAddToBackgroundSequence: (asset: Asset) => void;
  usedAssetIds: Set<string>;
  selectedBackgroundTrackId: string;
  onSelectBackgroundTrack: (id: string) => void;
  selectedTemplateId: string | null;
  onSelectTemplate: (id: string) => void;
  selectedClipRectId: string | null;
  onSelectClipRect: (id: string) => void;
  onOpenTextDialog: () => void;
  isTextDialogOpen: boolean;
  editingTextOverlay: TextOverlay | null;
  onSaveTextOverlay: (text: string, templateId: string, rect: CropRect) => void;
  onCloseTextDialog: () => void;
  // The actual current frame (closest thumbnail to the playhead) and its
  // aspect ratio, for TextOverlayDialog's live preview -- see its own
  // comment on why positioning happens against the real frame now.
  previewFrameUrl: string | null;
  frameAspectRatio: number | null;
  baseCropRect: CropRect | null;
  zoomEffects: ZoomEffect[];
  liveCropRectOverride: CropRect | null;
  flipHorizontalToggles: number[];
  flipVerticalToggles: number[];
  trimRanges: TrimRange[];
  overlayImages: OverlayImage[];
  textOverlays: TextOverlay[];
  sequenceClips: { assetId: string; url: string }[];
  backgroundTracks: { name: string; url: string }[];
  assetUrlById: Record<string, string>;
  onFrameDimensions: (dimensions: { width: number; height: number }) => void;
  // Lets ThreePaneEditor's Playground scrub this player and track a
  // playhead against it -- see CanvasPlayer.tsx's seekTo/onTimeUpdate.
  playerRef: RefObject<CanvasPlayerHandle | null>;
  onPlayerTimeUpdate: (seconds: number) => void;
}) {
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isStockDialogOpen, setIsStockDialogOpen] = useState(false);

  const sequenceKey = sequenceClips.map((clip) => clip.assetId).join(",");

  const selectedClipRectOption = CLIP_RECT_OPTIONS.find((option) => option.id === selectedClipRectId);
  const playAreaRatio = selectedClipRectOption
    ? selectedClipRectOption.widthRatio / selectedClipRectOption.heightRatio
    : WIDEST_CLIP_RATIO;

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
          onAddToSequence={onAddToSequence}
          onAddToBackgroundSequence={onAddToBackgroundSequence}
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
          onOpenTextDialog={onOpenTextDialog}
        />
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-end overflow-hidden rounded-md border border-border bg-neutral-950 p-2">
        <div className="h-full max-w-full" style={{ aspectRatio: `${playAreaRatio} / 1` }}>
          {sequenceClips.length > 0 ? (
            <CanvasPlayer
              key={sequenceKey}
              ref={playerRef}
              clips={sequenceClips}
              baseCropRect={baseCropRect}
              zoomEffects={zoomEffects}
              liveCropRectOverride={liveCropRectOverride}
              flipHorizontalToggles={flipHorizontalToggles}
              flipVerticalToggles={flipVerticalToggles}
              trimRanges={trimRanges}
              overlayImages={overlayImages}
              textOverlays={textOverlays}
              backgroundTracks={backgroundTracks}
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
              Right-click a video asset and choose &quot;Add&quot; to start editing
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

      {isTextDialogOpen && (
        <TextOverlayDialog
          editingOverlay={editingTextOverlay}
          previewFrameUrl={previewFrameUrl}
          frameAspectRatio={frameAspectRatio}
          onSave={(text, templateId: TextTemplateId, rect) => onSaveTextOverlay(text, templateId, rect)}
          onClose={onCloseTextDialog}
        />
      )}
    </div>
  );
}
