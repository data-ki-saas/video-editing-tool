"use client";

/**
 * Top band of the three-pane editor, left to right: the project switcher
 * (replaces the removed left navigation sidebar), this project's asset
 * gallery (replaces the always-visible upload dropzone -- "+ Asset" opens
 * UploadDialog instead), the user-actions panel (clip rectangles / text),
 * and a play area. The play area is playback-only -- no crop/flip editing
 * happens here; that all lives on FrameStrip's timeline (see
 * Playground.tsx), CanvasPlayer just renders the result.
 *
 * The play area shows the video SEQUENCE (sequenceClips), not whichever
 * asset is merely highlighted in the gallery: a sequence with clips in it
 * always wins the play-area slot, falling back to a standalone image
 * preview or a placeholder only when the sequence is empty. Left-clicking
 * a video asset no longer has any effect on what plays -- only right-click
 * "Add" builds the sequence -- but still sets `selectedAsset` for the
 * gallery's own highlight border and for previewing an image asset
 * directly.
 *
 * The action list -- a live summary of every transformation currently
 * ACTIVE on the clip (clip rectangle, each zoom/pan transition, every
 * flip/mirror window, etc.) -- sits immediately left of the play area, so
 * it reads alongside the video it describes. It's not a log of every click
 * that got here; undo/redo (Ctrl+Z/Ctrl+Y, see ThreePaneEditor.tsx) still
 * walks that click-by-click history underneath (lib/useEditHistory.ts) --
 * this list just shows what it currently adds up to.
 */
import { useState } from "react";
import { ProjectList } from "./ProjectList";
import { AssetGallery } from "./AssetGallery";
import { UploadDialog } from "./UploadDialog";
import { StockMediaDialog } from "./StockMediaDialog";
import { UserActions } from "./UserActions";
import { TextOverlayDialog } from "./TextOverlayDialog";
import { TranscriptCaptionDialog } from "./TranscriptCaptionDialog";
import { CutawayDialog } from "./CutawayDialog";
import type { CutawaySegment } from "./CutawayTrack";
import { ClipRectangleDialog } from "./ClipRectangleDialog";
import { VideoOverlayFramingDialog } from "./VideoOverlayFramingDialog";
import { ImageOverlayFramingDialog } from "./ImageOverlayFramingDialog";
import { VideoOverlayPickerDialog } from "./VideoOverlayPickerDialog";
import { ImageOverlayPickerDialog } from "./ImageOverlayPickerDialog";
import { OverlaySourceStartDialog } from "./OverlaySourceStartDialog";
import { CanvasPlayer, type CanvasPlayerHandle } from "./CanvasPlayer";
import { CLIP_RECT_OPTIONS } from "./ClipRectIcon";
import { TRANSCRIPT_CAPTION_TEMPLATE_OPTIONS } from "@/lib/video/transcriptCaptionTemplates";
import { computeFlipSegments } from "@/lib/video/video_math";
import type { Asset } from "@/lib/api";
import type { EditSelectionsSnapshot } from "@/lib/projects";
import type {
  CropRect,
  ImageOverlayClip,
  OverlayFraming,
  SequenceEntry,
  TextOverlay,
  TranscriptCaption,
  TrimRange,
  VideoOverlayClip,
  ZoomEffect,
} from "@/lib/video/video_math";
import type { TextTemplateId } from "@/lib/video/textTemplates";
import type { TranscriptCaptionTemplateId } from "@/lib/video/transcriptCaptionTemplates";
import type { RefObject } from "react";

function formatTimeRange(startTimeSeconds: number, endTimeSeconds: number): string {
  const format = (seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const wholeSeconds = Math.floor(seconds % 60);
    return `${minutes}:${wholeSeconds.toString().padStart(2, "0")}`;
  };
  return `${format(startTimeSeconds)}–${format(endTimeSeconds)}`;
}

function ActiveTransformationsList({
  selections,
  videoDurationSeconds,
}: {
  selections: EditSelectionsSnapshot;
  videoDurationSeconds: number;
}) {
  const rows: string[] = [];

  if (selections.clipRectId) {
    const option = CLIP_RECT_OPTIONS.find((candidate) => candidate.id === selections.clipRectId);
    rows.push(`Clip rectangle: ${option?.ratioLabel ?? selections.clipRectId}`);
  }
  for (const effect of selections.zoomEffects) {
    rows.push(`Zoom/pan ${formatTimeRange(effect.startTimeSeconds, effect.endTimeSeconds)}`);
  }
  for (const segment of computeFlipSegments(selections.flipHorizontalToggles, videoDurationSeconds)) {
    rows.push(`Flipped ${formatTimeRange(segment.startTimeSeconds, segment.endTimeSeconds)}`);
  }
  for (const segment of computeFlipSegments(selections.flipVerticalToggles, videoDurationSeconds)) {
    rows.push(`Mirrored ${formatTimeRange(segment.startTimeSeconds, segment.endTimeSeconds)}`);
  }
  for (const range of selections.trimRanges) {
    rows.push(`Trimmed ${formatTimeRange(range.startTimeSeconds, range.endTimeSeconds)}`);
  }
  const layoutLabel = (layout: { type: string }) =>
    layout.type === "full-screen" ? "Full-Screen" : layout.type === "picture-in-picture" ? "Picture-in-Picture" : "Split Screen";
  for (const overlay of selections.overlayImages) {
    rows.push(`Image overlay (${layoutLabel(overlay.layout)}) ${formatTimeRange(overlay.startTimeSeconds, overlay.endTimeSeconds)}`);
  }
  for (const overlay of selections.textOverlays) {
    rows.push(`Text "${overlay.text}" ${formatTimeRange(overlay.startTimeSeconds, overlay.endTimeSeconds)}`);
  }
  for (const overlay of selections.videoOverlays) {
    rows.push(`Video overlay (${layoutLabel(overlay.layout)}) ${formatTimeRange(overlay.startTimeSeconds, overlay.endTimeSeconds)}`);
  }
  if (selections.sequenceClips.length > 1) {
    rows.push(`Sequence: ${selections.sequenceClips.length} clips`);
  }
  if (selections.transcriptCaption) {
    const option = TRANSCRIPT_CAPTION_TEMPLATE_OPTIONS.find(
      (candidate) => candidate.id === selections.transcriptCaption?.templateId
    );
    rows.push(`Auto-captions: ${option?.name ?? selections.transcriptCaption.templateId}`);
  }

  if (rows.length === 0) {
    return <p className="text-xs text-muted">No transformations applied yet.</p>;
  }

  return (
    <ul className="flex h-full flex-col gap-0.5 overflow-y-auto">
      {rows.map((row, index) => (
        <li key={index} className="shrink-0 truncate rounded-md px-2 py-0.5 text-xs text-foreground">
          {row}
        </li>
      ))}
    </ul>
  );
}

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
  onAddImageOverlay,
  onAddToSequence,
  onAddVideoOverlay,
  onAddToBackgroundSequence,
  onOpenCutawayDialogForAsset,
  usedAssetIds,
  videoThumbnailUrlByAssetId,
  framingDialogOverlay,
  onSaveVideoOverlayFraming,
  onCloseVideoOverlayFramingDialog,
  onDeleteFramingDialogOverlay,
  imageFramingDialogOverlay,
  onSaveImageOverlayFraming,
  onCloseImageOverlayFramingDialog,
  onDeleteImageFramingDialogOverlay,
  sourceStartDialogOverlay,
  sourceStartDialogAssetUrl,
  sourceStartDialogAssetFilename,
  sourceStartDialogSourceDurationSeconds,
  onSaveOverlaySourceStart,
  onCloseOverlaySourceStartDialog,
  selectedClipRectId,
  onSelectClipRect,
  onOpenTextDialog,
  isTextDialogOpen,
  editingTextOverlay,
  onSaveTextOverlay,
  onCloseTextDialog,
  onOpenTranscriptDialog,
  isTranscriptDialogOpen,
  transcriptCaption,
  onSaveTranscriptCaption,
  onDisableTranscriptCaption,
  onCloseTranscriptDialog,
  onOpenCutawayDialog,
  isCutawayDialogOpen,
  editingCutaway,
  cutawayDialogPreselectedAssetId,
  onAddImageSequenceClip,
  onAddVideoSequenceClip,
  onCloseCutawayDialog,
  onDeleteCutaway,
  isVideoOverlayPickerOpen,
  onOpenVideoOverlayPicker,
  onCloseVideoOverlayPicker,
  isImageOverlayPickerOpen,
  onOpenImageOverlayPicker,
  onCloseImageOverlayPicker,
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
  videoOverlays,
  backgroundTracks,
  mainAudioVolume,
  backgroundVolume,
  assetUrlById,
  onFrameDimensions,
  playerRef,
  onPlayerTimeUpdate,
  selections,
  videoDurationSeconds,
}: {
  projectId: string;
  assets: Asset[];
  assetsLoaded: boolean;
  selectedAsset: Asset | null;
  onSelectAsset: (asset: Asset) => void;
  onUploaded: (asset: Asset) => void;
  onUploadingChange?: (isUploading: boolean) => void;
  onAssetDeleted: (assetId: string) => void;
  onAddImageOverlay: (asset: Asset) => void;
  onAddToSequence: (asset: Asset) => void;
  onAddVideoOverlay: (asset: Asset) => void;
  onAddToBackgroundSequence: (asset: Asset) => void;
  onOpenCutawayDialogForAsset: (asset: Asset) => void;
  usedAssetIds: Set<string>;
  videoThumbnailUrlByAssetId: Record<string, string>;
  // The overlay currently open in VideoOverlayFramingDialog, if any --
  // null means closed.
  framingDialogOverlay: VideoOverlayClip | null;
  onSaveVideoOverlayFraming: (
    framing: OverlayFraming,
    options?: { baseFraming?: OverlayFraming; ratio?: number; audioBalance?: number; rect?: CropRect }
  ) => void;
  onCloseVideoOverlayFramingDialog: () => void;
  onDeleteFramingDialogOverlay: () => void;
  // ImageOverlayFramingDialog's own equivalent of the four props above.
  imageFramingDialogOverlay: ImageOverlayClip | null;
  onSaveImageOverlayFraming: (framing: OverlayFraming, options?: { baseFraming?: OverlayFraming; ratio?: number; rect?: CropRect }) => void;
  onCloseImageOverlayFramingDialog: () => void;
  onDeleteImageFramingDialogOverlay: () => void;
  // The overlay currently open in OverlaySourceStartDialog, if any -- null
  // means closed. Resolved to the full overlay (not just an index) by
  // ThreePaneEditor, same convention as framingDialogOverlay above.
  sourceStartDialogOverlay: VideoOverlayClip | null;
  sourceStartDialogAssetUrl: string;
  sourceStartDialogAssetFilename: string;
  sourceStartDialogSourceDurationSeconds: number;
  onSaveOverlaySourceStart: (sourceStartSeconds: number) => void;
  onCloseOverlaySourceStartDialog: () => void;
  selectedClipRectId: string | null;
  onSelectClipRect: (id: string) => void;
  onOpenTextDialog: () => void;
  isTextDialogOpen: boolean;
  editingTextOverlay: TextOverlay | null;
  onSaveTextOverlay: (text: string, templateId: string, rect: CropRect) => void;
  onCloseTextDialog: () => void;
  onOpenTranscriptDialog: () => void;
  isTranscriptDialogOpen: boolean;
  transcriptCaption: TranscriptCaption | null;
  onSaveTranscriptCaption: (templateId: TranscriptCaptionTemplateId, rect: CropRect) => void;
  onDisableTranscriptCaption: () => void;
  onCloseTranscriptDialog: () => void;
  onOpenCutawayDialog: () => void;
  isCutawayDialogOpen: boolean;
  // Non-null when CutawayDialog was reopened from the Cutaways rail to edit
  // an existing IMAGE cutaway -- see that dialog's own `editing` prop.
  editingCutaway: CutawaySegment | null;
  // Non-null when CutawayDialog was opened via AssetGallery's right-click
  // "Cutaway" on a specific IMAGE asset -- see that dialog's own
  // `preselectedAssetId` prop.
  cutawayDialogPreselectedAssetId: string | null;
  onAddImageSequenceClip: (assetId: string, durationSeconds: number, templateIds: string[], cropRect: CropRect) => void;
  onAddVideoSequenceClip: (asset: Asset) => void;
  onCloseCutawayDialog: () => void;
  onDeleteCutaway: (segment: CutawaySegment) => void;
  isVideoOverlayPickerOpen: boolean;
  onOpenVideoOverlayPicker: () => void;
  onCloseVideoOverlayPicker: () => void;
  isImageOverlayPickerOpen: boolean;
  onOpenImageOverlayPicker: () => void;
  onCloseImageOverlayPicker: () => void;
  // The actual current frame (closest thumbnail to the playhead) and its
  // aspect ratio, for TextOverlayDialog/TranscriptCaptionDialog's live
  // preview -- see TextOverlayDialog's own comment on why positioning
  // happens against the real frame now.
  previewFrameUrl: string | null;
  frameAspectRatio: number | null;
  baseCropRect: CropRect | null;
  zoomEffects: ZoomEffect[];
  liveCropRectOverride: CropRect | null;
  flipHorizontalToggles: number[];
  flipVerticalToggles: number[];
  trimRanges: TrimRange[];
  overlayImages: ImageOverlayClip[];
  textOverlays: TextOverlay[];
  sequenceClips: (SequenceEntry & { url: string })[];
  videoOverlays: VideoOverlayClip[];
  backgroundTracks: { name: string; url: string }[];
  mainAudioVolume: number;
  backgroundVolume: number;
  assetUrlById: Record<string, string>;
  onFrameDimensions: (dimensions: { width: number; height: number }) => void;
  // Lets ThreePaneEditor's Playground scrub this player and track a
  // playhead against it -- see CanvasPlayer.tsx's seekTo/onTimeUpdate.
  playerRef: RefObject<CanvasPlayerHandle | null>;
  onPlayerTimeUpdate: (seconds: number) => void;
  selections: EditSelectionsSnapshot;
  videoDurationSeconds: number;
}) {
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isStockDialogOpen, setIsStockDialogOpen] = useState(false);
  // Local, unlike the other three dialogs' open/close state -- selecting a
  // ratio applies it (via onSelectClipRect, already a ThreePaneEditor-level
  // handler) and closes itself in the same click, so nothing outside this
  // component ever needs to know whether it's open.
  const [isClipRectDialogOpen, setIsClipRectDialogOpen] = useState(false);

  const sequenceKey = sequenceClips.map((clip) => `${clip.id}:${clip.kind === "image" ? clip.durationSeconds : ""}`).join(",");

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
          onAddImageOverlay={onAddImageOverlay}
          onAddToSequence={onAddToSequence}
          onAddVideoOverlay={onAddVideoOverlay}
          onAddToBackgroundSequence={onAddToBackgroundSequence}
          onOpenCutawayDialogForAsset={onOpenCutawayDialogForAsset}
          usedAssetIds={usedAssetIds}
          videoThumbnailUrlByAssetId={videoThumbnailUrlByAssetId}
        />
      </div>

      <div className="w-[30rem] shrink-0 overflow-hidden border-r border-border pr-4">
        <UserActions
          selectedClipRectId={selectedClipRectId}
          onOpenClipRectDialog={() => setIsClipRectDialogOpen(true)}
          onOpenCutawayDialog={onOpenCutawayDialog}
          cutawayCount={sequenceClips.length}
          onOpenVideoOverlayPicker={onOpenVideoOverlayPicker}
          videoOverlayCount={videoOverlays.length}
          onOpenImageOverlayPicker={onOpenImageOverlayPicker}
          imageOverlayCount={overlayImages.length}
          onOpenTextDialog={onOpenTextDialog}
          textOverlayCount={textOverlays.length}
          onOpenTranscriptDialog={onOpenTranscriptDialog}
          autoCaptionEnabled={transcriptCaption !== null}
        />
      </div>

      <div className="w-64 shrink-0 overflow-hidden border-r border-border pr-4">
        <ActiveTransformationsList selections={selections} videoDurationSeconds={videoDurationSeconds} />
      </div>

      <div className="flex flex-1 items-center justify-end p-2">
        {sequenceClips.length > 0 ? (
          // CanvasPlayer sizes its own visible panel from the canvas's real
          // intrinsic aspect ratio (already correct -- see its own module
          // comment) -- no synthetic aspect-ratio wrapper needed here, only
          // for the two fallback cases below that have no such panel of
          // their own.
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
            videoOverlays={videoOverlays}
            backgroundTracks={backgroundTracks}
            mainAudioVolume={mainAudioVolume}
            backgroundVolume={backgroundVolume}
            assetUrlById={assetUrlById}
            onFrameDimensions={onFrameDimensions}
            onTimeUpdate={onPlayerTimeUpdate}
          />
        ) : (
          <div
            className="h-full max-w-full overflow-hidden rounded-md border border-border bg-neutral-950"
            style={{ aspectRatio: `${playAreaRatio} / 1` }}
          >
            {selectedAsset?.kind === "image" ? (
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
        )}
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

      {isTranscriptDialogOpen && (
        <TranscriptCaptionDialog
          transcriptCaption={transcriptCaption}
          previewFrameUrl={previewFrameUrl}
          frameAspectRatio={frameAspectRatio}
          onSave={onSaveTranscriptCaption}
          onDisable={onDisableTranscriptCaption}
          onClose={onCloseTranscriptDialog}
        />
      )}

      {isCutawayDialogOpen && (
        <CutawayDialog
          assets={assets}
          videoThumbnailUrlByAssetId={videoThumbnailUrlByAssetId}
          clipRectAspectRatio={playAreaRatio}
          editing={
            editingCutaway?.kind === "image"
              ? {
                  assetId: editingCutaway.assetId,
                  templateIds: editingCutaway.templateIds,
                  durationSeconds: editingCutaway.durationSeconds,
                  cropRect: editingCutaway.cropRect,
                }
              : null
          }
          preselectedAssetId={cutawayDialogPreselectedAssetId}
          onAddImage={onAddImageSequenceClip}
          onAddVideo={(assetId) => {
            const asset = assets.find((a) => a.id === assetId);
            if (asset) onAddVideoSequenceClip(asset);
          }}
          onClose={onCloseCutawayDialog}
          onDelete={editingCutaway ? () => onDeleteCutaway(editingCutaway) : undefined}
        />
      )}

      {isClipRectDialogOpen && (
        <ClipRectangleDialog
          selectedClipRectId={selectedClipRectId}
          onSelect={onSelectClipRect}
          onClose={() => setIsClipRectDialogOpen(false)}
          previewFrameUrl={previewFrameUrl}
          frameAspectRatio={frameAspectRatio}
        />
      )}

      {isVideoOverlayPickerOpen && (
        <VideoOverlayPickerDialog
          assets={assets}
          videoThumbnailUrlByAssetId={videoThumbnailUrlByAssetId}
          onPick={onAddVideoOverlay}
          onClose={onCloseVideoOverlayPicker}
        />
      )}

      {isImageOverlayPickerOpen && (
        <ImageOverlayPickerDialog assets={assets} onPick={onAddImageOverlay} onClose={onCloseImageOverlayPicker} />
      )}

      {framingDialogOverlay && (
        <VideoOverlayFramingDialog
          overlay={framingDialogOverlay}
          baseFrameUrl={previewFrameUrl ?? ""}
          overlayFrameUrl={videoThumbnailUrlByAssetId[framingDialogOverlay.assetId] ?? ""}
          outputAspectRatio={frameAspectRatio}
          onSave={onSaveVideoOverlayFraming}
          onClose={onCloseVideoOverlayFramingDialog}
          onDelete={onDeleteFramingDialogOverlay}
        />
      )}

      {imageFramingDialogOverlay && (
        <ImageOverlayFramingDialog
          overlay={imageFramingDialogOverlay}
          baseFrameUrl={previewFrameUrl ?? ""}
          overlayFrameUrl={assetUrlById[imageFramingDialogOverlay.assetId] ?? ""}
          outputAspectRatio={frameAspectRatio}
          onSave={onSaveImageOverlayFraming}
          onClose={onCloseImageOverlayFramingDialog}
          onDelete={onDeleteImageFramingDialogOverlay}
        />
      )}

      {sourceStartDialogOverlay && (
        <OverlaySourceStartDialog
          overlay={sourceStartDialogOverlay}
          assetUrl={sourceStartDialogAssetUrl}
          assetFilename={sourceStartDialogAssetFilename}
          sourceDurationSeconds={sourceStartDialogSourceDurationSeconds}
          onSave={onSaveOverlaySourceStart}
          onClose={onCloseOverlaySourceStartDialog}
        />
      )}
    </div>
  );
}
