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
 * flip/mirror window, etc.) -- sits at the far right, past the play area.
 * It's not a log of every click that got here; undo/redo (Ctrl+Z/Ctrl+Y,
 * see ThreePaneEditor.tsx) still walks that click-by-click history
 * underneath (lib/useEditHistory.ts) -- this list just shows what it
 * currently adds up to.
 */
import { useState } from "react";
import { ProjectList } from "./ProjectList";
import { AssetGallery } from "./AssetGallery";
import { UploadDialog } from "./UploadDialog";
import { StockMediaDialog } from "./StockMediaDialog";
import { UserActions } from "./UserActions";
import { TextOverlayDialog } from "./TextOverlayDialog";
import { TtsOverlayDialog } from "./TtsOverlayDialog";
import { TtsAvatarDialog } from "./TtsAvatarDialog";
import { TranscriptCaptionDialog } from "./TranscriptCaptionDialog";
import { CutawayDialog } from "./CutawayDialog";
import type { CutawaySegment } from "./CutawayTrack";
import { ClipRectangleDialog } from "./ClipRectangleDialog";
import { FilterPresetDialog } from "./FilterPresetDialog";
import { CanvasFillDialog } from "./CanvasFillDialog";
import { CutTransitionDialog } from "./CutTransitionDialog";
import type { CutTransitionId } from "@/lib/video/cutTransitionPresets";
import type { CanvasFillMode } from "@/lib/video/canvasFillPresets";
import { VideoOverlayFramingDialog } from "./VideoOverlayFramingDialog";
import { ImageOverlayFramingDialog } from "./ImageOverlayFramingDialog";
import { VideoOverlayPickerDialog } from "./VideoOverlayPickerDialog";
import { ImageOverlayPickerDialog } from "./ImageOverlayPickerDialog";
import { OverlaySourceStartDialog } from "./OverlaySourceStartDialog";
import { CanvasPlayer, type CanvasPlayerHandle } from "./CanvasPlayer";
import { CLIP_RECT_OPTIONS } from "./ClipRectIcon";
import { getFilterPresetOption, type FilterPresetId } from "@/lib/video/filterPresets";
import { TRANSCRIPT_CAPTION_TEMPLATE_OPTIONS } from "@/lib/video/transcriptCaptionTemplates";
import { computeFlipSegments, ttsOverlayEndTimeSeconds, formatTimeRange, describeOverlayLayout } from "@/lib/video/video_math";
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
  TtsOverlay,
  VideoOverlayClip,
  ZoomEffect,
} from "@/lib/video/video_math";
import type { TextTemplateId } from "@/lib/video/textTemplates";
import type { TranscriptCaptionTemplateId } from "@/lib/video/transcriptCaptionTemplates";
import type { RefObject } from "react";

function ActiveTransformationsList({
  selections,
  videoDurationSeconds,
  onEditTtsOverlay,
  onDeleteTtsOverlay,
}: {
  selections: EditSelectionsSnapshot;
  videoDurationSeconds: number;
  // TTS overlays have no dedicated timeline rail (unlike text/image/video
  // overlays' own Track components) -- this list is their only edit/delete
  // entry point, so (unlike every other row here, which is plain summary
  // text) its own rows are interactive.
  onEditTtsOverlay: (index: number) => void;
  onDeleteTtsOverlay: (index: number) => void;
}) {
  // Plain-text summary rows and the interactive TTS rows are built up
  // separately (TTS overlays need onClick handlers the rest don't), then
  // merged into one list below so they can share a single latest-first
  // ordering instead of TTS rows always trailing at the bottom.
  const rows: string[] = [];

  if (selections.clipRectId) {
    const option = CLIP_RECT_OPTIONS.find((candidate) => candidate.id === selections.clipRectId);
    rows.push(`Clip rectangle: ${option?.ratioLabel ?? selections.clipRectId}`);
  }
  for (const entry of selections.sequenceClips) {
    if (entry.colorFilterId) rows.push(`Cutaway filter: ${getFilterPresetOption(entry.colorFilterId).name}`);
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
  const filterSuffix = (colorFilterId: EditSelectionsSnapshot["sequenceClips"][number]["colorFilterId"]) =>
    colorFilterId ? `, ${getFilterPresetOption(colorFilterId).name} filter` : "";
  for (const overlay of selections.overlayImages) {
    rows.push(
      `Image overlay (${describeOverlayLayout(overlay.layout)}${filterSuffix(overlay.colorFilterId)}) ${formatTimeRange(overlay.startTimeSeconds, overlay.endTimeSeconds)}`
    );
  }
  for (const overlay of selections.textOverlays) {
    rows.push(`Text "${overlay.text}" ${formatTimeRange(overlay.startTimeSeconds, overlay.endTimeSeconds)}`);
  }
  for (const overlay of selections.videoOverlays) {
    rows.push(
      `Video overlay (${describeOverlayLayout(overlay.layout)}${filterSuffix(overlay.colorFilterId)}) ${formatTimeRange(overlay.startTimeSeconds, overlay.endTimeSeconds)}`
    );
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

  if (rows.length === 0 && selections.ttsOverlays.length === 0) {
    return <p className="text-xs text-muted">No transformations applied yet.</p>;
  }

  const items = [
    ...rows.map((row, index) => (
      <li key={`row-${index}`} className="shrink-0 truncate rounded-md px-2 py-0.5 text-xs text-foreground">
        {row}
      </li>
    )),
    ...selections.ttsOverlays.map((overlay, index) => (
      <li key={`tts-${index}`} className="flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-xs text-foreground">
        <button
          type="button"
          onClick={() => onEditTtsOverlay(index)}
          className="min-w-0 flex-1 truncate text-left hover:underline"
          title="Edit this narration"
        >
          Narration ({overlay.displayMode === "karaoke" ? "karaoke" : overlay.displayMode === "none" ? "no text" : "captioned"}){" "}
          &quot;{overlay.text}&quot;{" "}
          {formatTimeRange(overlay.startTimeSeconds, ttsOverlayEndTimeSeconds(overlay))}
        </button>
        <button
          type="button"
          onClick={() => onDeleteTtsOverlay(index)}
          aria-label="Remove narration"
          title="Remove narration"
          className="shrink-0 text-muted hover:text-red-600"
        >
          ✕
        </button>
      </li>
    )),
  ];

  // Latest-first: within any one category items are appended in the order
  // they were added, so reversing the merged list surfaces each category's
  // most-recently-added item (and the most-recently-touched category) at
  // the top instead of always at the bottom.
  return <ul className="flex h-full flex-col gap-0.5 overflow-y-auto">{items.slice().reverse()}</ul>;
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
  onOpenVideoOverlayPickerForAsset,
  onAddToBackgroundSequence,
  onOpenCutawayDialogForAsset,
  usedAssetIds,
  videoThumbnailUrlByAssetId,
  framingDialogOverlay,
  framingDialogOverlayFrameUrl,
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
  filterDialogCutaway,
  filterDialogVideoOverlayIndex,
  filterDialogImageOverlayIndex,
  filterDialogCutawayPreviewFrameUrl,
  filterDialogVideoOverlayPreviewFrameUrl,
  filterDialogImageOverlayPreviewFrameUrl,
  onSelectCutawayFilter,
  onSelectVideoOverlayFilter,
  onSelectImageOverlayFilter,
  onCloseFilterDialog,
  canvasFillDialogCutaway,
  canvasFillDialogCutawayPreviewFrameUrl,
  onSelectCanvasFill,
  onCloseCanvasFillDialog,
  transitionDialogEntry,
  transitionDialogOutgoingFrameUrl,
  transitionDialogIncomingFrameUrl,
  onSelectClipTransition,
  onCloseTransitionDialog,
  onOpenTextDialog,
  isTextDialogOpen,
  editingTextOverlay,
  onSaveTextOverlay,
  onRequestEditTextOverlay,
  onDeleteTextOverlay,
  onCloseTextDialog,
  onOpenTtsDialog,
  isTtsDialogOpen,
  editingTtsOverlay,
  onSaveTtsOverlay,
  onCloseTtsDialog,
  onEditTtsOverlay,
  onDeleteTtsOverlay,
  onOpenTtsAvatarDialog,
  isTtsAvatarDialogOpen,
  onGeneratedTtsAvatar,
  onCloseTtsAvatarDialog,
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
  videoOverlayPickerPreselectedAssetId,
  onOpenVideoOverlayPicker,
  onCloseVideoOverlayPicker,
  onDeleteVideoOverlay,
  isImageOverlayPickerOpen,
  onOpenImageOverlayPicker,
  onCloseImageOverlayPicker,
  onDeleteImageOverlay,
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
  ttsOverlays,
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
  currentTimeSeconds,
  onSeek,
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
  onAddVideoOverlay: (asset: Asset, options?: { removeBackground?: boolean; chromaKeyColor?: string }) => void;
  onOpenVideoOverlayPickerForAsset: (asset: Asset) => void;
  onAddToBackgroundSequence: (asset: Asset) => void;
  onOpenCutawayDialogForAsset: (asset: Asset) => void;
  usedAssetIds: Set<string>;
  videoThumbnailUrlByAssetId: Record<string, string>;
  // The overlay currently open in VideoOverlayFramingDialog, if any --
  // null means closed.
  framingDialogOverlay: VideoOverlayClip | null;
  // The frame seeded at framingDialogOverlay's OWN marked start point
  // (falling back to videoThumbnailUrlByAssetId's generic per-asset frame
  // when none's been captured yet) -- ThreePaneEditor computes this since
  // it alone holds videoOverlayStartThumbnailByKey; null while no dialog
  // is open.
  framingDialogOverlayFrameUrl: string | null;
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
  // At most one of these three is non-null at a time -- which cutaway/
  // overlay's own FilterPresetDialog is currently open, set by that clip's
  // own right-click "Filter" (see CutawayTrack.tsx/ImageOverlayTrack.tsx/
  // VideoOverlayTrack.tsx's onOpenFilter).
  filterDialogCutaway: CutawaySegment | null;
  filterDialogVideoOverlayIndex: number | null;
  filterDialogImageOverlayIndex: number | null;
  // A frame from the actual clip/image each dialog is scoped to (its own
  // photo, its own midpoint frame, or its own overlay thumbnail) -- see
  // ThreePaneEditor's own comment on why this differs from previewFrameUrl
  // below (always the base track's frame at the current playhead).
  filterDialogCutawayPreviewFrameUrl: string | null;
  filterDialogVideoOverlayPreviewFrameUrl: string | null;
  filterDialogImageOverlayPreviewFrameUrl: string | null;
  onSelectCutawayFilter: (id: FilterPresetId) => void;
  onSelectVideoOverlayFilter: (id: FilterPresetId) => void;
  onSelectImageOverlayFilter: (id: FilterPresetId) => void;
  onCloseFilterDialog: () => void;
  // CanvasFillDialog's own currently-open target -- same one-state-per-
  // dialog-target convention as filterDialogCutaway above, opened by that
  // clip's own right-click "Canvas fill…" (CutawayTrack.tsx's onOpenCanvasFill).
  canvasFillDialogCutaway: CutawaySegment | null;
  canvasFillDialogCutawayPreviewFrameUrl: string | null;
  onSelectCanvasFill: (mode: CanvasFillMode, colors?: { color?: string; gradientColor?: string }) => void;
  onCloseCanvasFillDialog: () => void;
  // CutTransitionDialog's own currently-open target -- see
  // ThreePaneEditor.tsx's own transitionDialogEntry state comment.
  transitionDialogEntry: SequenceEntry | null;
  transitionDialogOutgoingFrameUrl: string | null;
  transitionDialogIncomingFrameUrl: string | null;
  onSelectClipTransition: (id: CutTransitionId | null) => void;
  onCloseTransitionDialog: () => void;
  onOpenTextDialog: () => void;
  isTextDialogOpen: boolean;
  editingTextOverlay: TextOverlay | null;
  onSaveTextOverlay: (text: string, templateId: string, rect: CropRect) => void;
  // TextOverlayDialog's own "Already on this reel" list -- re-points the
  // still-open dialog at a different existing caption (same handler
  // TextOverlayTrack's "Edit text" already uses).
  onRequestEditTextOverlay: (overlayIndex: number) => void;
  // TextOverlayDialog's own "Already on this reel" list -- deletes a row's
  // overlay outright (index-aware: keeps editingTextOverlay pointed at the
  // same overlay through the resulting shift, see ThreePaneEditor's own
  // handleDeleteTextOverlay).
  onDeleteTextOverlay: (overlayIndex: number) => void;
  onCloseTextDialog: () => void;
  onOpenTtsDialog: () => void;
  isTtsDialogOpen: boolean;
  editingTtsOverlay: TtsOverlay | null;
  onSaveTtsOverlay: (overlay: TtsOverlay) => void;
  onCloseTtsDialog: () => void;
  onEditTtsOverlay: (overlayIndex: number) => void;
  onDeleteTtsOverlay: (overlayIndex: number) => void;
  onOpenTtsAvatarDialog: () => void;
  isTtsAvatarDialogOpen: boolean;
  onGeneratedTtsAvatar: (asset: Asset) => void;
  onCloseTtsAvatarDialog: () => void;
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
  onAddVideoSequenceClip: (asset: Asset, options?: { removeBackground?: boolean }) => void;
  onCloseCutawayDialog: () => void;
  onDeleteCutaway: (segment: CutawaySegment) => void;
  isVideoOverlayPickerOpen: boolean;
  // Set by AssetGallery's right-click "Overlay" on a specific video tile --
  // see VideoOverlayPickerDialog's own preselectedAssetId prop comment.
  videoOverlayPickerPreselectedAssetId: string | null;
  onOpenVideoOverlayPicker: () => void;
  onCloseVideoOverlayPicker: () => void;
  // VideoOverlayPickerDialog's own "Already on this reel" list -- deletes
  // a row's overlay outright.
  onDeleteVideoOverlay: (overlayIndex: number) => void;
  isImageOverlayPickerOpen: boolean;
  onOpenImageOverlayPicker: () => void;
  onCloseImageOverlayPicker: () => void;
  // ImageOverlayPickerDialog's own "Already on this reel" list -- same as
  // onDeleteVideoOverlay above.
  onDeleteImageOverlay: (overlayIndex: number) => void;
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
  ttsOverlays: TtsOverlay[];
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
  // Current playhead position -- TtsOverlayDialog needs this as a freshly-
  // added overlay's own startTimeSeconds (see that dialog's own comment).
  currentTimeSeconds: number;
  // VideoOverlayPickerDialog/ImageOverlayPickerDialog's own "Already on
  // this reel" list -- jumps the live preview to an existing overlay's
  // start time when its row is clicked.
  onSeek: (seconds: number) => void;
}) {
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [isStockDialogOpen, setIsStockDialogOpen] = useState(false);
  // Local, unlike the other three dialogs' open/close state -- selecting a
  // ratio applies it (via onSelectClipRect, already a ThreePaneEditor-level
  // handler) and closes itself in the same click, so nothing outside this
  // component ever needs to know whether it's open.
  const [isClipRectDialogOpen, setIsClipRectDialogOpen] = useState(false);

  const sequenceKey = sequenceClips.map((clip) => `${clip.id}:${clip.kind === "image" ? clip.durationSeconds : ""}`).join(",");

  // Resolves each filter-dialog target down to the actual clip object it
  // refers to, same "look it up from the target id/index right before
  // rendering" convention as framingDialogOverlay/imageFramingDialogOverlay
  // (ThreePaneEditor.tsx) -- null whenever that target isn't the one
  // currently open (at most one of the three ever is).
  const filterDialogCutawayEntry = filterDialogCutaway
    ? (sequenceClips.find((entry) => entry.id === filterDialogCutaway.entryId) ?? null)
    : null;
  const canvasFillDialogCutawayEntry = canvasFillDialogCutaway
    ? (sequenceClips.find((entry) => entry.id === canvasFillDialogCutaway.entryId) ?? null)
    : null;
  const filterDialogVideoOverlay =
    filterDialogVideoOverlayIndex !== null ? (videoOverlays[filterDialogVideoOverlayIndex] ?? null) : null;
  const filterDialogImageOverlay =
    filterDialogImageOverlayIndex !== null ? (overlayImages[filterDialogImageOverlayIndex] ?? null) : null;

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
          onOpenVideoOverlayPickerForAsset={onOpenVideoOverlayPickerForAsset}
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
          onOpenTtsDialog={onOpenTtsDialog}
          ttsOverlayCount={ttsOverlays.length}
          onOpenTtsAvatarDialog={onOpenTtsAvatarDialog}
          onOpenTranscriptDialog={onOpenTranscriptDialog}
          autoCaptionEnabled={transcriptCaption !== null}
        />
      </div>

      <div className="flex flex-1 items-center justify-start p-2">
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
            outputAspectRatio={playAreaRatio}
            flipHorizontalToggles={flipHorizontalToggles}
            flipVerticalToggles={flipVerticalToggles}
            trimRanges={trimRanges}
            overlayImages={overlayImages}
            textOverlays={textOverlays}
            ttsOverlays={ttsOverlays}
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

      <div className="w-64 shrink-0 overflow-hidden border-l border-border pl-4">
        <ActiveTransformationsList
          selections={selections}
          videoDurationSeconds={videoDurationSeconds}
          onEditTtsOverlay={onEditTtsOverlay}
          onDeleteTtsOverlay={onDeleteTtsOverlay}
        />
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
          textOverlays={selections.textOverlays}
          previewFrameUrl={previewFrameUrl}
          frameAspectRatio={frameAspectRatio}
          onSave={(text, templateId: TextTemplateId, rect) => onSaveTextOverlay(text, templateId, rect)}
          onSelectExisting={(overlayIndex) => {
            const overlay = selections.textOverlays[overlayIndex];
            if (overlay) onSeek(overlay.startTimeSeconds);
            onRequestEditTextOverlay(overlayIndex);
          }}
          onDeleteExisting={onDeleteTextOverlay}
          onClose={onCloseTextDialog}
        />
      )}

      {isTtsDialogOpen && (
        <TtsOverlayDialog
          projectId={projectId}
          editingOverlay={editingTtsOverlay}
          editingOverlayAssetUrl={editingTtsOverlay ? (assetUrlById[editingTtsOverlay.assetId] ?? null) : null}
          previewFrameUrl={previewFrameUrl}
          frameAspectRatio={frameAspectRatio}
          currentTimeSeconds={currentTimeSeconds}
          onSave={onSaveTtsOverlay}
          onClose={onCloseTtsDialog}
        />
      )}

      {isTtsAvatarDialogOpen && (
        <TtsAvatarDialog projectId={projectId} onGenerated={onGeneratedTtsAvatar} onClose={onCloseTtsAvatarDialog} />
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
                  backgroundRemoval: editingCutaway.backgroundRemoval,
                  camera3D: editingCutaway.camera3D,
                  ambientEffect: editingCutaway.ambientEffect,
                  audioReactive: editingCutaway.audioReactive,
                }
              : null
          }
          preselectedAssetId={cutawayDialogPreselectedAssetId}
          onAddImage={onAddImageSequenceClip}
          onAddVideo={(assetId, options) => {
            const asset = assets.find((a) => a.id === assetId);
            if (asset) onAddVideoSequenceClip(asset, options);
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

      {filterDialogCutawayEntry && (
        <FilterPresetDialog
          selectedFilterId={filterDialogCutawayEntry.colorFilterId ?? null}
          onSelect={onSelectCutawayFilter}
          onClose={onCloseFilterDialog}
          previewFrameUrl={filterDialogCutawayPreviewFrameUrl ?? previewFrameUrl}
          frameAspectRatio={frameAspectRatio}
          scopeLabel="this cutaway"
        />
      )}

      {canvasFillDialogCutawayEntry && (
        <CanvasFillDialog
          selectedMode={canvasFillDialogCutawayEntry.canvasFillMode ?? null}
          selectedColor={canvasFillDialogCutawayEntry.canvasFillColor}
          selectedGradientColor={canvasFillDialogCutawayEntry.canvasFillGradientColor}
          onSelect={onSelectCanvasFill}
          onClose={onCloseCanvasFillDialog}
          previewFrameUrl={canvasFillDialogCutawayPreviewFrameUrl ?? previewFrameUrl}
          outputAspectRatio={playAreaRatio}
          scopeLabel="this cutaway"
        />
      )}

      {transitionDialogEntry && (
        <CutTransitionDialog
          selectedTransitionId={transitionDialogEntry.cutTransitionInId ?? null}
          onSelect={onSelectClipTransition}
          onClose={onCloseTransitionDialog}
          outgoingFrameUrl={transitionDialogOutgoingFrameUrl}
          incomingFrameUrl={transitionDialogIncomingFrameUrl}
          frameAspectRatio={frameAspectRatio}
        />
      )}

      {filterDialogVideoOverlay && (
        <FilterPresetDialog
          selectedFilterId={filterDialogVideoOverlay.colorFilterId ?? null}
          onSelect={onSelectVideoOverlayFilter}
          onClose={onCloseFilterDialog}
          previewFrameUrl={filterDialogVideoOverlayPreviewFrameUrl ?? previewFrameUrl}
          frameAspectRatio={frameAspectRatio}
          scopeLabel="this overlay"
        />
      )}

      {filterDialogImageOverlay && (
        <FilterPresetDialog
          selectedFilterId={filterDialogImageOverlay.colorFilterId ?? null}
          onSelect={onSelectImageOverlayFilter}
          onClose={onCloseFilterDialog}
          previewFrameUrl={filterDialogImageOverlayPreviewFrameUrl ?? previewFrameUrl}
          frameAspectRatio={frameAspectRatio}
          scopeLabel="this overlay"
        />
      )}

      {isVideoOverlayPickerOpen && (
        <VideoOverlayPickerDialog
          assets={assets}
          videoThumbnailUrlByAssetId={videoThumbnailUrlByAssetId}
          videoOverlays={selections.videoOverlays}
          videoDurationSeconds={videoDurationSeconds}
          preselectedAssetId={videoOverlayPickerPreselectedAssetId}
          onPick={onAddVideoOverlay}
          onLocateOverlay={(overlayIndex) => {
            const overlay = selections.videoOverlays[overlayIndex];
            if (overlay) onSeek(overlay.startTimeSeconds);
          }}
          onDeleteOverlay={onDeleteVideoOverlay}
          onClose={onCloseVideoOverlayPicker}
        />
      )}

      {isImageOverlayPickerOpen && (
        <ImageOverlayPickerDialog
          assets={assets}
          overlayImages={selections.overlayImages}
          videoDurationSeconds={videoDurationSeconds}
          onPick={onAddImageOverlay}
          onLocateOverlay={(overlayIndex) => {
            const overlay = selections.overlayImages[overlayIndex];
            if (overlay) onSeek(overlay.startTimeSeconds);
          }}
          onDeleteOverlay={onDeleteImageOverlay}
          onClose={onCloseImageOverlayPicker}
        />
      )}

      {framingDialogOverlay && (
        <VideoOverlayFramingDialog
          overlay={framingDialogOverlay}
          baseFrameUrl={previewFrameUrl ?? ""}
          overlayFrameUrl={framingDialogOverlayFrameUrl ?? ""}
          outputAspectRatio={playAreaRatio}
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
          outputAspectRatio={playAreaRatio}
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
