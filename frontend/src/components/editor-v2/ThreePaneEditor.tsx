"use client";

/**
 * Top-level layout for the client-side video editor -- the one and only
 * editor, rendered directly by /dashboard/[projectId]. The pre-editor-v2
 * Creatomate-based dashboard (VideoEditor.tsx/QuickCreate.tsx and their
 * EditorPanelContext/useRenderStatus plumbing) has been removed entirely --
 * nothing routed to it any more. The Creatomate render backend itself
 * (api/render/route.ts, the webhook, worker/) is untouched: editor-v2 has
 * no render pipeline of its own yet, so that's still what a future "render
 * this reel" action would hook into.
 *
 * A fixed-height TopMenuBar (render actions left, settings/sign-out right)
 * sits above three horizontal bands that split the remaining height
 * 3:7 -- action area, playground -- plus a one-line feedback strip pinned
 * to the bottom. This component owns the cross-band state (the full asset
 * list, the video sequence, the frame-affecting edit history, playback
 * position, crop/zoom/flip/trim/overlay/text) and the thumbnail/volume
 * extraction pipeline; each band below is otherwise a plain, mostly-
 * stateless view. It does NOT contain transformation decision logic itself
 * -- see lib/video/transformations.ts for "given the current selections and
 * an action, what's the new state," which this component just calls and
 * pushes through useEditHistory.
 *
 * Template and background-track choices are plain persisted state, not
 * part of the edit history -- they don't change what the frames look like
 * (yet), and the change list (ActionArea's action-list column) is meant to
 * show only actions that do. Everything frame-affecting (clip rectangle,
 * zoom/pan, flip, trim, image/text overlays, and which videos are in the
 * sequence) goes through useEditHistory.
 *
 * The video "selection" is no longer a single asset: `selections.sequenceClips`
 * is an ordered list of clips concatenated into one continuous timeline --
 * either a "video" entry (right-click "Add" on a video asset appends one;
 * the first Add is what starts rendering frames at all, every later one
 * plays right after whatever's already there) or an "image" entry (the
 * "Image Templates" toolbar tool), which additionally carries its own
 * authored duration and Ken Burns template id, since a still image has no
 * intrinsic duration to probe. Everything else -- crop, zoom/pan, flip,
 * trim, overlays -- is defined purely in terms of "elapsed seconds across
 * the sequence" and has no idea a video is more than one physical file, or
 * that some clips are stills; only this component's own extraction
 * pipeline and CanvasPlayer needed real changes to support that (an image
 * clip is treated as "a video with exactly one frame, held for its
 * authored duration, with silent audio").
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listAssets, deleteAsset, type Asset } from "@/lib/api";
import { extractThumbnails, getVideoDuration, captureSingleFrame } from "@/lib/video/video";
import {
  generateSampleTimestamps,
  findClosestTimestampIndex,
  computeOutputDimensions,
  DEFAULT_OVERLAY_FRAMING,
  DEFAULT_SPLIT_SCREEN_RATIO,
  DEFAULT_MAIN_AUDIO_VOLUME,
  DEFAULT_BACKGROUND_VOLUME,
  videoOverlayStartThumbnailKey,
  type CropRect,
  type ImageOverlayClip,
  type SequenceEntry,
  type TextOverlay,
  type TtsOverlay,
  type OverlayFraming,
  type VideoOverlayClip,
  type VideoOverlayLayout,
  type ZoomEffect,
} from "@/lib/video/video_math";
import {
  applySelectClipRect,
  applyCropRectCommit,
  applyZoomRangeChange,
  applyZoomEpicenterChange,
  applyDeleteZoomEffect,
  applyFlipToggle,
  applyTrimTrackClick,
  applyDeleteTrimRange,
  applyAddImageOverlay,
  applyChangeImageOverlayLayout,
  applyToggleImageSplitScreenOrientation,
  applyToggleImageSplitScreenSides,
  applyImageOverlayRectChange,
  applyImageOverlayRangeChange,
  applyImageOverlayPositionChange,
  applyChangeImageOverlayFraming,
  applyDeleteImageOverlay,
  applyAddSequenceClip,
  applyAddImageSequenceClip,
  applyEditImageSequenceClip,
  applyDeleteSequenceClip,
  applyResizeImageClip,
  applyAddTextOverlay,
  applyEditTextOverlay,
  applyTextOverlayRectCommit,
  applyTextOverlayRangeChange,
  applyDeleteTextOverlay,
  applyAddTtsOverlay,
  applyEditTtsOverlay,
  applyDeleteTtsOverlay,
  applyTtsOverlayPositionChange,
  applyTtsOverlayVolumeChange,
  applyEnableTranscriptCaption,
  applyUpdateTranscriptCaption,
  applyDisableTranscriptCaption,
  applyAddVideoOverlay,
  applyChangeVideoOverlayLayout,
  applyToggleSplitScreenOrientation,
  applyToggleSplitScreenSides,
  applyVideoOverlayRectChange,
  applyVideoOverlayRangeChange,
  applyVideoOverlayPositionChange,
  applyChangeOverlayFraming,
  applyChangeOverlayAudioBalance,
  applyDeleteVideoOverlay,
  applyChangeVideoOverlaySourceStart,
  applySelectCutawayFilterPreset,
  applySelectImageOverlayFilterPreset,
  applySelectVideoOverlayFilterPreset,
  applySelectClipTransition,
} from "@/lib/video/transformations";
import type { FilterPresetId } from "@/lib/video/filterPresets";
import type { CutTransitionId } from "@/lib/video/cutTransitionPresets";
import {
  saveTimeline,
  type Timeline,
  type EditSelectionsSnapshot,
  type Project,
  type TimelineMarker,
} from "@/lib/projects";
import { useEditHistory } from "@/lib/useEditHistory";
import { useRenderStatus } from "@/lib/useRenderStatus";
import { useLocalRender } from "@/lib/useLocalRender";
import { gatherLocalSequenceClips, gatherLocalBackgroundClips } from "@/lib/localRender/gatherLocalRenderClips";
import { CLIP_RECT_OPTIONS } from "./ClipRectIcon";
import { BACKGROUND_TRACK_OPTIONS } from "@/lib/backgroundTracks";
import { DEFAULT_MARKER_LABEL } from "./MarkerTrack";
import { ActionArea } from "./ActionArea";
import { TopMenuBar } from "./TopMenuBar";
import { Playground } from "./Playground";
import type { CutawaySegment } from "./CutawayTrack";
import { FeedbackArea } from "./FeedbackArea";
import type { CanvasPlayerHandle } from "./CanvasPlayer";
import { RenderComingSoonPopup } from "./RenderComingSoonPopup";
import { LocalRenderPopup } from "./LocalRenderPopup";

const THUMBNAIL_INTERVAL_SECONDS = 1;
const SAVE_DEBOUNCE_MS = 600;

const DEFAULT_SELECTIONS: EditSelectionsSnapshot = {
  clipRectId: null,
  cropRect: null,
  zoomEffects: [],
  flipHorizontalToggles: [],
  flipVerticalToggles: [],
  trimRanges: [],
  overlayImages: [],
  textOverlays: [],
  ttsOverlays: [],
  sequenceClips: [],
  videoOverlays: [],
  transcriptCaption: null,
};

export function ThreePaneEditor({
  projectId,
  initialTimeline,
  initialProject,
}: {
  projectId: string;
  initialTimeline: Timeline;
  initialProject: Project;
}) {
  const {
    isRendering,
    renderStatus,
    renderUrl,
    renderError,
    isStuck: isRenderStuck,
    applyProjectStatus,
  } = useRenderStatus(projectId);

  const {
    isSupported: isLocalRenderSupported,
    unsupportedReason: localRenderUnsupportedReason,
    isRendering: isLocalRendering,
    progress: localRenderProgress,
    resultUrl: localRenderUrl,
    resultMimeType: localRenderMimeType,
    resultError: localRenderError,
    resultWarnings: localRenderWarnings,
    startLocalRender,
  } = useLocalRender();

  useEffect(() => {
    applyProjectStatus(initialProject);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial-mount seed only; applyProjectStatus is a fresh closure from the hook every render
  }, []);

  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const [thumbnails, setThumbnails] = useState<string[]>([]);
  // In lockstep with `thumbnails` -- see FrameStrip's own comment for why
  // a concatenated sequence can't derive each tile's timestamp from its
  // index alone any more.
  const [thumbnailTimestampsSeconds, setThumbnailTimestampsSeconds] = useState<number[]>([]);
  // Each clip's own start time (after the first) in the concatenated
  // sequence, for FrameStrip's clip-boundary divider lines.
  const [clipBoundarySeconds, setClipBoundarySeconds] = useState<number[]>([]);
  const [videoDurationSeconds, setVideoDurationSeconds] = useState(0);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [frameDimensions, setFrameDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Live position of the crop rect while actively dragging on FrameStrip's
  // active tile, before it's committed to history -- kept separate from
  // `selections.cropRect` so a drag-in-progress doesn't spam the change
  // list (see handleCropRectCommit), and fed to CanvasPlayer so the player
  // previews the drag live even though it's no longer where the dragging
  // itself happens.
  const [liveCropRect, setLiveCropRect] = useState<CropRect | null>(null);

  // Live position of one zoom effect's time range while actively dragging
  // one of ZoomEffectsTrack's segment edges, before it's committed -- same
  // change-vs-commit split as liveCropRect above. Tracks which effect
  // (by index into selections.zoomEffects) is being dragged, since any of
  // several can be.
  const [liveZoomEffectEdit, setLiveZoomEffectEdit] = useState<{ index: number; effect: ZoomEffect } | null>(null);

  // The first click of TrimTrack's two-click "place a trim" gesture --
  // null until a dot is pending, cleared again as soon as the second
  // click completes (or cancels) it. Never persisted -- it's mid-gesture
  // state, not a committed trim.
  const [pendingTrimStartSeconds, setPendingTrimStartSeconds] = useState<number | null>(null);

  // Live position of one image overlay's rect while actively dragging its
  // OverlayRectOverlay handles on FrameStrip's active tile, before it's
  // committed -- same change-vs-commit split as liveCropRect above.
  const [liveOverlayRectEdit, setLiveOverlayRectEdit] = useState<{ index: number; rect: CropRect } | null>(null);

  // Live time range of one image overlay while actively dragging its
  // ImageOverlayTrack segment edges, before it's committed -- same split
  // again.
  const [liveOverlayRangeEdit, setLiveOverlayRangeEdit] = useState<{
    index: number;
    startTimeSeconds: number;
    endTimeSeconds: number;
  } | null>(null);
  // Live position of one image overlay while dragging the MIDDLE of its
  // ImageOverlayTrack segment (move without changing duration) -- image
  // overlay's own equivalent of liveVideoOverlayPositionEdit below.
  const [liveOverlayPositionEdit, setLiveOverlayPositionEdit] = useState<{ index: number; startTimeSeconds: number } | null>(null);

  // Same live-edit split again, for text overlays' rect/range dragging.
  const [liveTextOverlayRectEdit, setLiveTextOverlayRectEdit] = useState<{ index: number; rect: CropRect } | null>(null);
  const [liveTextOverlayRangeEdit, setLiveTextOverlayRangeEdit] = useState<{
    index: number;
    startTimeSeconds: number;
    endTimeSeconds: number;
  } | null>(null);

  // Video overlays (see video_math.ts's VideoOverlayClip) get the same
  // three-way live-edit split as image/text overlays: a Picture-in-Picture
  // box's rect drag (reusing OverlayRectOverlay on FrameStrip's active
  // tile, exactly like an image overlay), an edge drag on
  // VideoOverlayTrack (trims duration), and a body drag on the same track
  // (the new "move without changing duration" gesture -- see that file's
  // own module comment).
  const [liveVideoOverlayRectEdit, setLiveVideoOverlayRectEdit] = useState<{ index: number; rect: CropRect } | null>(null);
  const [liveVideoOverlayRangeEdit, setLiveVideoOverlayRangeEdit] = useState<{
    index: number;
    startTimeSeconds: number;
    endTimeSeconds: number;
  } | null>(null);
  const [liveVideoOverlayPositionEdit, setLiveVideoOverlayPositionEdit] = useState<{
    index: number;
    startTimeSeconds: number;
  } | null>(null);
  // VideoOverlayTrack's own per-segment volume slider, same live-edit split again.
  const [liveOverlayAudioBalanceEdit, setLiveOverlayAudioBalanceEdit] = useState<{ index: number; balance: number } | null>(null);

  // TtsOverlayTrack's own body drag (move, duration is fixed -- see that
  // file's own module comment) and per-segment volume badge, same live-edit
  // split as every other overlay type above.
  const [liveTtsOverlayPositionEdit, setLiveTtsOverlayPositionEdit] = useState<{ index: number; startTimeSeconds: number } | null>(null);
  const [liveTtsOverlayVolumeEdit, setLiveTtsOverlayVolumeEdit] = useState<{ index: number; volume: number } | null>(null);

  // A representative still frame per video asset -- lifted up from
  // AssetGallery.tsx (which used to generate this locally) since
  // VideoOverlayTrack.tsx needs the exact same thumbnails and lives in a
  // sibling subtree, not a descendant of AssetGallery.
  const [videoThumbnailUrlByAssetId, setVideoThumbnailUrlByAssetId] = useState<Record<string, string>>({});
  // Each video overlay source asset's own probed full duration, by
  // assetId -- VideoOverlayTrack's edge-drag needs this to clamp a
  // Full-Screen/Split-Screen overlay's window so it never asks to play
  // more of the source than exists (its in-point is fixed at 0 for v1).
  const [overlaySourceDurationSeconds, setOverlaySourceDurationSeconds] = useState<Record<string, number>>({});
  // A still frame captured AT each overlay placement's own sourceStartSeconds
  // (flag icon / OverlaySourceStartDialog), keyed by videoOverlayStartThumbnailKey
  // -- lets FrameStrip's main track show what the overlay actually looks like
  // from its marked start point, instead of the one generic per-asset
  // thumbnail (always frame ~0.1s) videoThumbnailUrlByAssetId above provides.
  const [videoOverlayStartThumbnailByKey, setVideoOverlayStartThumbnailByKey] = useState<Record<string, string>>({});

  // TextOverlayDialog's open/edit-target state -- null editingTextOverlayIndex
  // means "Add" (a fresh overlay); otherwise it's pre-filled for editing
  // that existing overlay's text/template.
  const [isTextDialogOpen, setIsTextDialogOpen] = useState(false);
  const [editingTextOverlayIndex, setEditingTextOverlayIndex] = useState<number | null>(null);

  // TtsOverlayDialog's own open/edit-target state -- same add-vs-edit
  // duality as the text dialog's above.
  const [isTtsDialogOpen, setIsTtsDialogOpen] = useState(false);
  const [editingTtsOverlayIndex, setEditingTtsOverlayIndex] = useState<number | null>(null);

  // TranscriptCaptionDialog's open state -- no edit-target index needed,
  // there's only ever one transcript caption config (see
  // video_math.ts's TranscriptCaption).
  const [isTranscriptDialogOpen, setIsTranscriptDialogOpen] = useState(false);
  const [isCutawayDialogOpen, setIsCutawayDialogOpen] = useState(false);
  // Non-null while CutawayDialog is open in EDIT mode (image cutaways only
  // -- a video cutaway has nothing to edit in place), reopened by clicking
  // a segment on the Cutaways rail (CutawayTrack) rather than the "Cutaway"
  // tab -- see handleEditCutaway/handleAddImageSequenceClip.
  const [editingCutaway, setEditingCutaway] = useState<CutawaySegment | null>(null);
  // Non-null when CutawayDialog was opened via AssetGallery's right-click
  // "Cutaway" on a specific IMAGE asset -- an ADD, not an edit (editingCutaway
  // above stays null), just pre-selects that photo in the dialog's own
  // picker instead of defaulting to the first one.
  const [cutawayDialogPreselectedAssetId, setCutawayDialogPreselectedAssetId] = useState<string | null>(null);

  // FilterPresetDialog's open/edit-target state -- three separate targets
  // (same "one state var per dialog target type" convention as
  // editingCutaway/framingDialogOverlayIndex/imageFramingDialogOverlayIndex
  // below) since a cutaway, a video overlay, and an image overlay each has
  // its own independent colorFilterId now (see video_math.ts's
  // SequenceEntry/VideoOverlayClip/ImageOverlayClip). At most one is
  // non-null at a time -- opened from that clip's own right-click "Filter".
  const [filterDialogCutaway, setFilterDialogCutaway] = useState<CutawaySegment | null>(null);
  // CutTransitionDialog's own currently-open target -- the INCOMING clip of
  // whichever boundary badge was clicked on FrameStrip (cutTransitionInId
  // lives on this entry, never on the one before it -- see
  // video_math.ts's SequenceEntry doc comment).
  const [transitionDialogEntry, setTransitionDialogEntry] = useState<SequenceEntry | null>(null);
  const [filterDialogVideoOverlayIndex, setFilterDialogVideoOverlayIndex] = useState<number | null>(null);
  const [filterDialogImageOverlayIndex, setFilterDialogImageOverlayIndex] = useState<number | null>(null);

  // VideoOverlayFramingDialog's open/edit-target state -- opened from the
  // crosshair button on a VideoOverlayTrack segment, per-overlay index
  // (null means closed, not "add new" -- there's always an existing
  // overlay to fine-tune, unlike the text dialog's add-vs-edit duality).
  const [framingDialogOverlayIndex, setFramingDialogOverlayIndex] = useState<number | null>(null);
  // ImageOverlayFramingDialog's own equivalent -- a separate index since an
  // image overlay and a video overlay are independent arrays/rails (see
  // video_math.ts's ImageOverlayClip doc comment).
  const [imageFramingDialogOverlayIndex, setImageFramingDialogOverlayIndex] = useState<number | null>(null);
  // "Video Overlay"/"Image Overlay" tabs' own small asset-picker dialogs --
  // see VideoOverlayPickerDialog.tsx/ImageOverlayPickerDialog.tsx. Picking a
  // tile adds that asset instantly (same as AssetGallery's right-click
  // "Overlay") and closes the picker itself.
  const [isVideoOverlayPickerOpen, setIsVideoOverlayPickerOpen] = useState(false);
  const [isImageOverlayPickerOpen, setIsImageOverlayPickerOpen] = useState(false);

  // Named points on the main sequence's own timeline (MarkerTrack.tsx) --
  // cosmetic/not undo-tracked, same tier as selectedBackgroundTrackId (see
  // projects.ts's TimelineMarker doc comment for why).
  const [markers, setMarkers] = useState<TimelineMarker[]>(initialTimeline.markers ?? []);

  // OverlaySourceStartDialog's open/edit-target state -- opened from the
  // flag icon on a VideoOverlayTrack segment, alongside its framing button.
  // By INDEX (not assetId): sourceStartSeconds is a per-placement field on
  // VideoOverlayClip, not shared across every use of the same asset, so
  // this follows the same per-index convention as framingDialogOverlayIndex
  // above rather than the old assetId-keyed AssetMarkersDialog state.
  const [sourceStartDialogOverlayIndex, setSourceStartDialogOverlayIndex] = useState<number | null>(null);

  // The cloud (Creatomate) render is temporarily disabled -- see
  // handleRenderClick below, which shows this instead of actually starting
  // a render.
  const [isRenderComingSoonOpen, setIsRenderComingSoonOpen] = useState(false);

  // Opened by handleLocalRenderClick right before the export starts, and
  // stays open through completion/failure -- LocalRenderPopup itself
  // decides what to show (loader vs. finished player vs. error) from the
  // useLocalRender() state below.
  const [isLocalRenderPopupOpen, setIsLocalRenderPopupOpen] = useState(false);

  const canvasPlayerRef = useRef<CanvasPlayerHandle>(null);

  // Cosmetic-only, persisted but not history-tracked (see this file's
  // module comment). No UI sets this anymore (the Template picker was
  // removed), but a project saved while it existed still carries a value
  // here, so it's kept around to round-trip on save rather than dropped.
  const selectedTemplateId = initialTimeline.selectedTemplateId ?? null;
  // No UI sets this anymore (the curated Background track picker was
  // removed), but a project saved while it existed still carries a value
  // here, and handleAddToBackgroundSequence still resets it to "none" for
  // mutual exclusivity with a project's own asset(s) below, so it stays a
  // real state value rather than a plain constant.
  const [selectedBackgroundTrackId, setSelectedBackgroundTrackId] = useState(
    initialTimeline.selectedBackgroundTrackId ?? "none"
  );
  // Set instead of selectedBackgroundTrackId when the background music is
  // one or more of this project's own assets -- ordered, appended to by
  // AssetGallery's right-click "Add" on a music tile (multiple tracks
  // concatenate, see BackgroundTrackStrip) -- mutually exclusive with the
  // catalog choice, see handleAddToBackgroundSequence.
  // Seeds from the old singular `selectedBackgroundAssetId` field if the
  // array form isn't present yet (the one commit where it briefly existed
  // in that shape) -- a one-time runtime seed, not a persisted migration.
  const [backgroundSequenceAssetIds, setBackgroundSequenceAssetIds] = useState<string[]>(
    initialTimeline.backgroundSequenceAssetIds ??
      (initialTimeline.selectedBackgroundAssetId ? [initialTimeline.selectedBackgroundAssetId] : [])
  );

  // Flat 0..1 volume for each audio rail's own VolumeBadge (Playground.tsx)
  // -- cosmetic/not undo-tracked, same tier as selectedBackgroundTrackId
  // above (see projects.ts's Timeline.mainAudioVolume doc comment). Falls
  // back to what was hardcoded before either of these controls existed, so
  // an old reel's rendered loudness doesn't change out from under it.
  const [mainAudioVolume, setMainAudioVolume] = useState(initialTimeline.mainAudioVolume ?? DEFAULT_MAIN_AUDIO_VOLUME);
  const [backgroundVolume, setBackgroundVolume] = useState(initialTimeline.backgroundVolume ?? DEFAULT_BACKGROUND_VOLUME);

  // Frame-affecting, history-tracked -- every change is a revertible entry
  // in FeedbackArea's change list, persisted into Timeline.editHistory so
  // reopening this reel resumes with the same history intact.
  const {
    state: rawSelections,
    entries: editHistoryEntries,
    currentIndex: editHistoryIndex,
    pushChange,
    undo,
    redo,
  } = useEditHistory<EditSelectionsSnapshot>(DEFAULT_SELECTIONS, initialTimeline.editHistory, initialTimeline.editHistoryIndex);

  // Timeline.editHistory is untyped JSON from Supabase -- an entry saved
  // before a shape change (e.g. the flipHorizontal/flipVertical booleans
  // that predate the toggle-list model) is missing fields the rest of this
  // component assumes exist. This isn't a migration -- it makes no attempt
  // to read what an old field meant -- it's just a crash guard: a missing
  // field defaults to empty/unset rather than leaving `undefined` for the
  // first .length/.filter/.findIndex on it to throw on.
  //
  // sequenceClips is the one exception that DOES read an old field's
  // meaning: it replaced sequenceAssetIds (a plain string[] of video asset
  // ids) when image clips were added, and unlike a cosmetic shape change,
  // this field holds a user's actual video sequence -- silently dropping it
  // would erase real content on every project saved before this change. A
  // legacy sequenceAssetIds is converted into the new SequenceEntry shape
  // (each a "video" entry, since that's the only kind that used to exist);
  // once any project resaves under the new shape, this branch is dead for
  // it going forward.
  // Generated ids must stay STABLE across re-renders (FrameStrip's per-clip
  // drag handles, the thumbnail-extraction effect's clip key, etc. all key
  // off entry.id) -- memoized on rawSelections itself, which only changes
  // on an actual undo/redo/pushChange, not on every render.
  const sequenceClips: SequenceEntry[] = useMemo(() => {
    if (rawSelections.sequenceClips) return rawSelections.sequenceClips;
    const legacySequenceAssetIds = (rawSelections as unknown as { sequenceAssetIds?: string[] }).sequenceAssetIds ?? [];
    return legacySequenceAssetIds.map((assetId) => ({ id: crypto.randomUUID(), kind: "video" as const, assetId }));
  }, [rawSelections]);

  // `framing` (every layout), `baseFraming`/`ratio` (split-screen only), and
  // individual OverlayFraming fields added later (e.g. `zoom`) were all
  // added after some projects already had a video overlay -- or an
  // OverlayFraming object -- persisted without them. Backfilling here (once,
  // at load, via a deep default-merge so an EXISTING framing object still
  // heals a newer missing field like `zoom` rather than only covering "the
  // whole object is absent") heals old data at the source instead of
  // leaving every reader (CanvasPlayer, exportTimeline, computeOverlayRects,
  // VideoOverlayFramingDialog) to guess a default.
  //
  // Memoized on rawSelections itself, same as sequenceClips above and for
  // the same reason: VideoOverlayFramingDialog re-syncs its own draft state
  // (ratio/framing/pipRect) whenever the `overlay` object it's passed
  // changes identity, so recomputing this array on every render (e.g. every
  // currentTimeSeconds tick during playback) was wiping an in-progress
  // divider/zoom/pan drag before the user ever got to click Save.
  const videoOverlays: VideoOverlayClip[] = useMemo(
    () =>
      (rawSelections.videoOverlays ?? []).map((overlay) => {
        const framing = { ...DEFAULT_OVERLAY_FRAMING, ...overlay.framing };
        if (overlay.layout.type !== "split-screen") return { ...overlay, framing };
        return {
          ...overlay,
          framing,
          layout: {
            ...overlay.layout,
            baseFraming: { ...DEFAULT_OVERLAY_FRAMING, ...overlay.layout.baseFraming },
            ratio: overlay.layout.ratio ?? DEFAULT_SPLIT_SCREEN_RATIO,
          },
        };
      }),
    [rawSelections]
  );

  // A project's `overlayImages` entry may still be in the OLD shape (just a
  // fixed `rect`, no `layout`/`framing` -- see video_math.ts's now-deprecated
  // OverlayImage) if it was saved before images grew the same switchable
  // layout system videoOverlays already had. Upgrades each one into an
  // ImageOverlayClip at load time: a legacy `rect` becomes a
  // Picture-in-Picture layout wrapping that exact rect (renders pixel-
  // identical to what it already showed), a new-shape entry gets the same
  // framing/baseFraming/ratio backfill merge videoOverlays above already
  // does. Memoized on rawSelections for the same reason as videoOverlays
  // above -- see that block's own comment.
  const overlayImages: ImageOverlayClip[] = useMemo(
    () =>
      (rawSelections.overlayImages ?? []).map((overlay): ImageOverlayClip => {
        const legacy = overlay as unknown as { rect?: CropRect; layout?: VideoOverlayLayout };
        if (!legacy.layout && legacy.rect) {
          return {
            assetId: overlay.assetId,
            startTimeSeconds: overlay.startTimeSeconds,
            endTimeSeconds: overlay.endTimeSeconds,
            layout: { type: "picture-in-picture", rect: legacy.rect },
            framing: DEFAULT_OVERLAY_FRAMING,
          };
        }
        const framing = { ...DEFAULT_OVERLAY_FRAMING, ...overlay.framing };
        if (overlay.layout.type !== "split-screen") return { ...overlay, framing };
        return {
          ...overlay,
          framing,
          layout: {
            ...overlay.layout,
            baseFraming: { ...DEFAULT_OVERLAY_FRAMING, ...overlay.layout.baseFraming },
            ratio: overlay.layout.ratio ?? DEFAULT_SPLIT_SCREEN_RATIO,
          },
        };
      }),
    [rawSelections]
  );

  const selections: EditSelectionsSnapshot = {
    clipRectId: rawSelections.clipRectId ?? null,
    cropRect: rawSelections.cropRect ?? null,
    zoomEffects: rawSelections.zoomEffects ?? [],
    flipHorizontalToggles: rawSelections.flipHorizontalToggles ?? [],
    flipVerticalToggles: rawSelections.flipVerticalToggles ?? [],
    trimRanges: rawSelections.trimRanges ?? [],
    overlayImages,
    textOverlays: rawSelections.textOverlays ?? [],
    ttsOverlays: rawSelections.ttsOverlays ?? [],
    sequenceClips,
    videoOverlays,
    transcriptCaption: rawSelections.transcriptCaption ?? null,
  };

  // Ctrl/Cmd+Z to undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z to redo (both redo
  // conventions are common enough -- Windows apps mostly use Ctrl+Y, Mac
  // and many web apps use Cmd+Shift+Z -- that it's not worth picking just
  // one). Skipped while focus is in a text input/textarea/contenteditable
  // (e.g. renaming the reel) so this doesn't fight with the browser's own
  // undo inside that field.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const isModifierPressed = e.ctrlKey || e.metaKey;
      if (!isModifierPressed) return;

      const key = e.key.toLowerCase();
      const isUndo = key === "z" && !e.shiftKey;
      const isRedo = key === "y" || (key === "z" && e.shiftKey);
      if (!isUndo && !isRedo) return;

      const target = e.target as HTMLElement | null;
      const isEditingText =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (isEditingText) return;

      e.preventDefault();
      if (isUndo) undo();
      else redo();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo]);

  // Returns the freshly-fetched list (not just the ones already in state) --
  // handleLocalRenderClick needs this to rebuild fresh presigned URLs for
  // the render it's about to start, since the `assets`/`assetUrlById` this
  // component already has in scope could be up to r2_signed_url_expires_seconds
  // old (whatever they were when this project was last opened/refreshed),
  // and a slow local export (see exportTimeline.ts) can easily outlast a
  // stale URL otherwise. Mirrors the cloud render's own "resolve fresh URLs
  // right before the actual operation" approach (api/render/route.ts's
  // resolveAssetSources), just done client-side instead of server-side.
  const refreshAssets = useCallback(async (): Promise<Asset[]> => {
    try {
      const data = await listAssets(projectId);
      setAssets(data);
      setAssetsError(null);
      // Defaults the gallery's highlighted asset to the most recently
      // uploaded video once assets first load -- doesn't override a
      // selection the user (or a just-finished upload) already made. Only
      // cosmetic now: the sequence (below), not this, drives what plays.
      setSelectedAsset((prev) => prev ?? data.find((asset) => asset.kind === "video") ?? null);
      return data;
    } catch (err) {
      setAssetsError(err instanceof Error ? err.message : "Failed to load assets");
      return [];
    } finally {
      setAssetsLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    // refreshAssets() itself only calls setState after its await -- this
    // fetch-on-mount/projectId-change pattern is what the effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAssets();
  }, [refreshAssets]);

  // assetId -> presigned R2 URL, for CanvasPlayer/FrameStrip/OverlayTrack/
  // BackgroundTrackStrip to resolve an id to its actual file without each
  // needing their own asset-list lookup.
  const assetUrlById = Object.fromEntries(assets.map((asset) => [asset.id, asset.url]));

  // Generates one representative frame per video asset, once, the first
  // time it shows up here -- images use their own URL directly (no
  // extraction needed) and are skipped. Previously local to AssetGallery.tsx;
  // moved up here since VideoOverlayTrack.tsx needs the same thumbnails.
  useEffect(() => {
    let cancelled = false;
    for (const asset of assets) {
      if (asset.kind !== "video" || videoThumbnailUrlByAssetId[asset.id]) continue;
      captureSingleFrame(asset.url)
        .then((frame) => {
          if (!cancelled) setVideoThumbnailUrlByAssetId((prev) => ({ ...prev, [asset.id]: frame }));
        })
        .catch(() => {
          // Leaves this tile/overlay block on its fallback icon -- not
          // worth surfacing a thumbnail failure as a page-level error.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [assets, videoThumbnailUrlByAssetId]);

  // Probes every video overlay's source asset's own real duration once,
  // by assetId -- VideoOverlayTrack's edge-drag clamp needs this (see its
  // own comment). Re-runs when a project loads with overlays already
  // referencing assets not yet probed, not only right after adding one.
  const videoOverlayAssetIds = useMemo(
    () => Array.from(new Set(selections.videoOverlays.map((overlay) => overlay.assetId))),
    [selections.videoOverlays]
  );
  useEffect(() => {
    let cancelled = false;
    for (const assetId of videoOverlayAssetIds) {
      if (overlaySourceDurationSeconds[assetId] !== undefined) continue;
      const url = assetUrlById[assetId];
      if (!url) continue;
      getVideoDuration(url)
        .then((duration) => {
          if (!cancelled) setOverlaySourceDurationSeconds((prev) => ({ ...prev, [assetId]: duration }));
        })
        .catch(() => {
          // Leaves this asset's cap unresolved -- VideoOverlayTrack's edge-drag
          // just degrades to only the neighbor/sequence clamps for it.
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- assetUrlById is a fresh object every render; videoOverlayAssetIds (memoized) is what actually gates this
  }, [videoOverlayAssetIds]);

  // Captures one still frame per (assetId, sourceStartSeconds) pair actually
  // in use across the current overlays -- so FrameStrip's main track can show
  // each overlay starting from the point its flag icon marked, not just a
  // generic frame-0.1s thumbnail. Re-runs whenever a placement's own start
  // point moves (Save in OverlaySourceStartDialog), same trigger as the
  // sourceStartSeconds field itself.
  const videoOverlayStartThumbnailKeys = useMemo(
    () =>
      Array.from(
        new Set(selections.videoOverlays.map((overlay) => videoOverlayStartThumbnailKey(overlay.assetId, overlay.sourceStartSeconds)))
      ),
    [selections.videoOverlays]
  );
  useEffect(() => {
    let cancelled = false;
    for (const overlay of selections.videoOverlays) {
      const key = videoOverlayStartThumbnailKey(overlay.assetId, overlay.sourceStartSeconds);
      if (videoOverlayStartThumbnailByKey[key]) continue;
      const url = assetUrlById[overlay.assetId];
      if (!url) continue;
      captureSingleFrame(url, Math.max(overlay.sourceStartSeconds, 0.1))
        .then((frame) => {
          if (!cancelled) setVideoOverlayStartThumbnailByKey((prev) => ({ ...prev, [key]: frame }));
        })
        .catch(() => {
          // Leaves this placement on FrameStrip's generic per-asset
          // thumbnail fallback -- not worth surfacing as a page-level error.
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selections.videoOverlays/assetUrlById are fresh objects every render; videoOverlayStartThumbnailKeys (memoized) is what actually gates this
  }, [videoOverlayStartThumbnailKeys]);

  // The sequence to actually play: persisted sequenceClips, filtered to
  // entries whose asset still resolves (so a deleted asset silently drops
  // out of playback instead of breaking it). If that's empty and a video
  // asset exists, falls back to that one video as a NON-PERSISTED runtime
  // default (mirrors the old auto-select-most-recent-video behavior for
  // existing/first-time projects, without writing a synthetic history
  // entry). Each resolved clip carries its own `url` (for CanvasPlayer/
  // FrameStrip/the extraction effect below) alongside whatever the entry
  // itself already has -- `durationSeconds` is authored for an image entry,
  // still absent (probed below) for a video one.
  const resolvedSequenceEntries = sequenceClips.filter((entry) => assetUrlById[entry.assetId]);
  const fallbackVideoAsset = assets.find((asset) => asset.kind === "video") ?? null;
  const effectiveSequenceEntries: SequenceEntry[] =
    resolvedSequenceEntries.length > 0
      ? resolvedSequenceEntries
      : fallbackVideoAsset
        ? [{ id: fallbackVideoAsset.id, kind: "video", assetId: fallbackVideoAsset.id }]
        : [];
  const playbackClips = effectiveSequenceEntries.map((entry) => ({ ...entry, url: assetUrlById[entry.assetId] }));
  // Includes each image entry's own durationSeconds -- a duration edit
  // (FrameStrip's post-add resize handle) must re-trigger extraction, not
  // just an id/kind change.
  const sequenceClipsKey = playbackClips
    .map((clip) => `${clip.id}:${clip.kind === "image" ? clip.durationSeconds : ""}`)
    .join(",");

  // Unfolds the video sequence into a per-second thumbnail strip + duration,
  // one clip at a time. Sequential, not concurrent, so the strip fills in
  // progressively left to right (each clip's results append to the
  // accumulating thumbnails/thumbnailTimestampsSeconds arrays as soon as
  // that one clip finishes) rather than waiting on the whole sequence at
  // once. A clip that fails to load (bad URL, decode error) is skipped --
  // reported once, but doesn't block the rest of the sequence from
  // extracting.
  useEffect(() => {
    if (playbackClips.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setThumbnails([]);
      setThumbnailTimestampsSeconds([]);
      setClipBoundarySeconds([]);
      setVideoDurationSeconds(0);
      setCurrentTimeSeconds(0);
      setFrameDimensions(null);
      setAnalysisError(null);
      return;
    }

    let cancelled = false;
    setIsAnalyzing(true);
    setAnalysisError(null);
    setThumbnails([]);
    setThumbnailTimestampsSeconds([]);
    setClipBoundarySeconds([]);
    setCurrentTimeSeconds(0);

    function reportFailure(err: unknown) {
      if (cancelled) return;
      const message = err instanceof Error ? err.message : "Failed to analyze this video";
      setAnalysisError(
        `${message} -- if this looks like a CORS/security error, the R2 uploads bucket needs its CORS ` +
          `policy configured (see DEPLOY.md / backend/scripts/configure_r2_cors.py).`
      );
    }

    async function extractSequence() {
      let cursor = 0;
      const boundaries: number[] = [];
      let accumulatedThumbnails: string[] = [];
      let accumulatedTimestamps: number[] = [];

      for (const clip of playbackClips) {
        if (cancelled) return;
        if (cursor > 0) boundaries.push(cursor);
        const clipStartSeconds = cursor;

        if (clip.kind === "image") {
          // An image clip has no file to probe/decode -- its duration is
          // authored (see lib/video/imageTemplates.ts), its "thumbnails"
          // are just its own URL held for every sampled tick (same
          // shortcut AssetGallery.tsx already uses for image tiles).
          const clipDurationSeconds = clip.durationSeconds;
          const clipTimestamps = generateSampleTimestamps(clipDurationSeconds, THUMBNAIL_INTERVAL_SECONDS).map(
            (t) => t + clipStartSeconds
          );
          accumulatedThumbnails = [...accumulatedThumbnails, ...clipTimestamps.map(() => clip.url)];
          accumulatedTimestamps = [...accumulatedTimestamps, ...clipTimestamps];
          setThumbnails(accumulatedThumbnails);
          setThumbnailTimestampsSeconds(accumulatedTimestamps);

          cursor += clipDurationSeconds;
          setVideoDurationSeconds(cursor);
          setClipBoundarySeconds([...boundaries]);
          continue;
        }

        let clipDurationSeconds: number;
        try {
          clipDurationSeconds = await getVideoDuration(clip.url);
        } catch (err) {
          reportFailure(err);
          continue;
        }
        if (cancelled) return;

        try {
          const clipThumbnails = await extractThumbnails(clip.url, THUMBNAIL_INTERVAL_SECONDS);
          if (cancelled) return;
          accumulatedThumbnails = [...accumulatedThumbnails, ...clipThumbnails];
          const clipTimestamps = generateSampleTimestamps(clipDurationSeconds, THUMBNAIL_INTERVAL_SECONDS).map(
            (t) => t + clipStartSeconds
          );
          accumulatedTimestamps = [...accumulatedTimestamps, ...clipTimestamps];
          setThumbnails(accumulatedThumbnails);
          setThumbnailTimestampsSeconds(accumulatedTimestamps);
        } catch (err) {
          if (cancelled) return;
          reportFailure(err);
        }

        cursor += clipDurationSeconds;
        setVideoDurationSeconds(cursor);
        setClipBoundarySeconds([...boundaries]);
      }
    }

    extractSequence().finally(() => {
      if (!cancelled) setIsAnalyzing(false);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the joined clip-id string (sequenceClipsKey), not the sequenceClips array reference, so an unrelated re-render doesn't re-trigger a full re-extraction
  }, [sequenceClipsKey]);

  // Persists selections into Timeline whenever any of them change,
  // debounced -- and flushes any pending save immediately on unmount (see
  // the second effect below) rather than silently dropping a change made
  // just before switching reels or navigating away.
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSaveRef = useRef<() => void>(() => {});
  const hasSkippedInitialSaveRef = useRef(false);

  useEffect(() => {
    if (!hasSkippedInitialSaveRef.current) {
      hasSkippedInitialSaveRef.current = true;
      return;
    }

    const doSave = () => {
      const nextTimeline: Timeline = {
        ...initialTimeline,
        editHistory: editHistoryEntries,
        editHistoryIndex,
        selectedTemplateId,
        selectedBackgroundTrackId,
        backgroundSequenceAssetIds,
        selectedBackgroundAssetId: undefined,
        markers,
        mainAudioVolume,
        backgroundVolume,
      };
      saveTimeline(projectId, nextTimeline)
        .then(() => setSaveError(null))
        .catch((err) => setSaveError(err instanceof Error ? err.message : "Failed to save your changes"));
    };

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(doSave, SAVE_DEBOUNCE_MS);
    flushSaveRef.current = () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      doSave();
    };

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [
    projectId,
    initialTimeline,
    editHistoryEntries,
    editHistoryIndex,
    selectedTemplateId,
    selectedBackgroundTrackId,
    backgroundSequenceAssetIds,
    markers,
    mainAudioVolume,
    backgroundVolume,
  ]);

  useEffect(() => {
    return () => flushSaveRef.current();
  }, []);

  function handleUploaded(asset: Asset) {
    setAssets((prev) => [asset, ...prev]);
    setSelectedAsset(asset);
  }

  function handleAssetDeleted(assetId: string) {
    setAssets((prev) => prev.filter((asset) => asset.id !== assetId));
    setSelectedAsset((prev) => (prev?.id === assetId ? null : prev));
    setBackgroundSequenceAssetIds((prev) => prev.filter((id) => id !== assetId));
    setSourceStartDialogOverlayIndex((prev) =>
      prev !== null && selections.videoOverlays[prev]?.assetId === assetId ? null : prev
    );

    const referencesDeletedAsset =
      selections.overlayImages.some((overlay) => overlay.assetId === assetId) ||
      selections.sequenceClips.some((entry) => entry.assetId === assetId) ||
      selections.videoOverlays.some((overlay) => overlay.assetId === assetId) ||
      selections.ttsOverlays.some((overlay) => overlay.assetId === assetId);
    if (referencesDeletedAsset) {
      const { label, state } = {
        label: "Removed deleted asset",
        state: {
          ...selections,
          overlayImages: selections.overlayImages.filter((overlay) => overlay.assetId !== assetId),
          sequenceClips: selections.sequenceClips.filter((entry) => entry.assetId !== assetId),
          videoOverlays: selections.videoOverlays.filter((overlay) => overlay.assetId !== assetId),
          ttsOverlays: selections.ttsOverlays.filter((overlay) => overlay.assetId !== assetId),
        },
      };
      pushChange(label, state);
    }
  }

  function handleSelectClipRect(id: string) {
    const option = CLIP_RECT_OPTIONS.find((candidate) => candidate.id === id);
    const targetRatio = option ? option.widthRatio / option.heightRatio : 1;
    const sourceAspectRatio = frameDimensions ? frameDimensions.width / frameDimensions.height : targetRatio;
    const { label, state } = applySelectClipRect(selections, id, targetRatio, sourceAspectRatio);
    pushChange(label, state);
  }

  function handleFlip(axis: "horizontal" | "vertical") {
    const { label, state } = applyFlipToggle(selections, axis, currentTimeSeconds);
    pushChange(label, state);
  }

  // Opens FilterPresetDialog scoped to one cutaway/overlay -- mirrors
  // handleEditCutaway/handleOpenImageOverlayFraming/
  // handleOpenVideoOverlayFraming's own "set this dialog target, the others
  // stay null" convention.
  function handleOpenCutawayFilter(segment: CutawaySegment) {
    setFilterDialogCutaway(segment);
  }

  function handleOpenImageOverlayFilter(overlayIndex: number) {
    setFilterDialogImageOverlayIndex(overlayIndex);
  }

  function handleOpenVideoOverlayFilter(overlayIndex: number) {
    setFilterDialogVideoOverlayIndex(overlayIndex);
  }

  function handleSelectCutawayFilter(id: FilterPresetId) {
    if (!filterDialogCutaway) return;
    const { label, state } = applySelectCutawayFilterPreset(selections, filterDialogCutaway.entryId, id);
    pushChange(label, state);
  }

  // FrameStrip's own clip-boundary badge click -- same "set this dialog
  // target" convention as handleOpenCutawayFilter above.
  function handleOpenClipTransition(entry: SequenceEntry) {
    setTransitionDialogEntry(entry);
  }

  function handleSelectClipTransition(id: CutTransitionId | null) {
    if (!transitionDialogEntry) return;
    const { label, state } = applySelectClipTransition(selections, transitionDialogEntry.id, id);
    pushChange(label, state);
  }

  function handleSelectImageOverlayFilter(id: FilterPresetId) {
    if (filterDialogImageOverlayIndex === null) return;
    const { label, state } = applySelectImageOverlayFilterPreset(selections, filterDialogImageOverlayIndex, id);
    pushChange(label, state);
  }

  function handleSelectVideoOverlayFilter(id: FilterPresetId) {
    if (filterDialogVideoOverlayIndex === null) return;
    const { label, state } = applySelectVideoOverlayFilterPreset(selections, filterDialogVideoOverlayIndex, id);
    pushChange(label, state);
  }

  // Fired by whichever tile is currently interactive on FrameStrip's
  // timeline (see its module comment) -- the player itself is playback-only
  // and never originates these, only displays liveCropRect below as a
  // preview of the drag in progress.
  function handleCropRectChange(next: CropRect) {
    setLiveCropRect(next);
  }

  function handleCropRectCommit(next: CropRect) {
    setLiveCropRect(null);
    const { label, state } = applyCropRectCommit(selections, currentTimeSeconds, next);
    pushChange(label, state);
  }

  function handleChangeZoomRange(effectIndex: number, startTimeSeconds: number, endTimeSeconds: number) {
    const zoomEffect = selections.zoomEffects[effectIndex];
    if (!zoomEffect) return;
    setLiveZoomEffectEdit({ index: effectIndex, effect: { ...zoomEffect, startTimeSeconds, endTimeSeconds } });
  }

  function handleCommitZoomRange(effectIndex: number, startTimeSeconds: number, endTimeSeconds: number) {
    if (!selections.zoomEffects[effectIndex]) return;
    setLiveZoomEffectEdit(null);
    const { label, state } = applyZoomRangeChange(selections, effectIndex, startTimeSeconds, endTimeSeconds);
    pushChange(label, state);
  }

  function handleChangeZoomEpicenter(effectIndex: number, epicenterTimeSeconds: number) {
    const zoomEffect = selections.zoomEffects[effectIndex];
    if (!zoomEffect) return;
    setLiveZoomEffectEdit({ index: effectIndex, effect: { ...zoomEffect, epicenterTimeSeconds } });
  }

  function handleCommitZoomEpicenter(effectIndex: number, epicenterTimeSeconds: number) {
    if (!selections.zoomEffects[effectIndex]) return;
    setLiveZoomEffectEdit(null);
    const { label, state } = applyZoomEpicenterChange(selections, effectIndex, epicenterTimeSeconds);
    pushChange(label, state);
  }

  function handleDeleteZoomEffect(effectIndex: number) {
    setLiveZoomEffectEdit((prev) => (prev?.index === effectIndex ? null : prev));
    const { label, state } = applyDeleteZoomEffect(selections, effectIndex);
    pushChange(label, state);
  }

  function handleTrimTrackClick(clickTimeSeconds: number) {
    const { historyChange, nextPendingTrimStartSeconds } = applyTrimTrackClick(
      selections,
      pendingTrimStartSeconds,
      clickTimeSeconds
    );
    setPendingTrimStartSeconds(nextPendingTrimStartSeconds);
    if (historyChange) pushChange(historyChange.label, historyChange.state);
  }

  function handleDeleteTrimRange(rangeIndex: number) {
    const { label, state } = applyDeleteTrimRange(selections, rangeIndex);
    pushChange(label, state);
  }

  // Right-click "Overlay" on an image asset in AssetGallery, or a tile
  // picked from ImageOverlayPickerDialog (the "Image Overlay" tab) --
  // places it on its own rail at the current playhead, defaulting to a
  // Picture-in-Picture layout the user can switch afterward, exact parity
  // with handleAddVideoOverlay below (see video_math.ts's ImageOverlayClip).
  function handleAddImageOverlay(asset: Asset) {
    const { label, state } = applyAddImageOverlay(selections, asset.id, currentTimeSeconds, videoDurationSeconds);
    pushChange(label, state);
    setIsImageOverlayPickerOpen(false);
  }

  // Right-click "Cutaway" on a video asset in AssetGallery -- appends it to
  // the concatenated sequence. The first one is what starts rendering
  // frames at all; every later one plays right after whatever's already
  // there. Also what CutawayDialog's video-kind "Add cutaway" calls.
  function handleAddToSequence(asset: Asset) {
    const { label, state } = applyAddSequenceClip(selections, asset.id);
    pushChange(label, state);
    setIsCutawayDialogOpen(false);
    setCutawayDialogPreselectedAssetId(null);
  }

  // Right-click "Overlay" on a video asset in AssetGallery, or a tile
  // picked from VideoOverlayPickerDialog (the "Video Overlay" tab) --
  // places it on its own rail at the current playhead, defaulting to a
  // Full-Screen layout the user can switch afterward (see
  // VideoOverlayTrack.tsx). Needs the source asset's own probed duration to
  // size/clamp the default window against -- reuses the cache built by the
  // probing effect above, or probes it fresh (and caches it) if this is the
  // first time this asset's been used this way.
  async function handleAddVideoOverlay(asset: Asset) {
    let sourceDurationSeconds = overlaySourceDurationSeconds[asset.id];
    if (sourceDurationSeconds === undefined) {
      try {
        sourceDurationSeconds = await getVideoDuration(asset.url);
        setOverlaySourceDurationSeconds((prev) => ({ ...prev, [asset.id]: sourceDurationSeconds! }));
      } catch {
        sourceDurationSeconds = Infinity; // probe failed -- the edge-drag clamp still falls back to [0, videoDurationSeconds]
      }
    }
    const { label, state } = applyAddVideoOverlay(selections, asset.id, sourceDurationSeconds, currentTimeSeconds, videoDurationSeconds);
    pushChange(label, state);
    setIsVideoOverlayPickerOpen(false);
  }

  // VideoOverlayTrack's right-click "Switch to..." entries -- an instant
  // change, no drag/commit split needed.
  function handleChangeVideoOverlayLayout(
    overlayIndex: number,
    layoutType: VideoOverlayLayout["type"],
    splitScreenOrientation?: "horizontal" | "vertical"
  ) {
    const { label, state } = applyChangeVideoOverlayLayout(selections, overlayIndex, layoutType, splitScreenOrientation);
    pushChange(label, state);
  }

  // VideoOverlayTrack's small inline icons on an active Split Screen
  // segment -- both instant one-click toggles.
  function handleToggleSplitScreenOrientation(overlayIndex: number) {
    const { label, state } = applyToggleSplitScreenOrientation(selections, overlayIndex);
    pushChange(label, state);
  }

  function handleToggleSplitScreenSides(overlayIndex: number) {
    const { label, state } = applyToggleSplitScreenSides(selections, overlayIndex);
    pushChange(label, state);
  }

  // A Picture-in-Picture overlay's box, dragged via the reused
  // OverlayRectOverlay handles on FrameStrip's active tile -- same
  // live-edit/commit split as handleChangeImageOverlayRect/
  // handleCommitImageOverlayRect below, for the equivalent image-overlay
  // feature.
  function handleChangeVideoOverlayRect(overlayIndex: number, next: CropRect) {
    setLiveVideoOverlayRectEdit({ index: overlayIndex, rect: next });
  }

  function handleCommitVideoOverlayRect(overlayIndex: number, next: CropRect) {
    setLiveVideoOverlayRectEdit(null);
    const { label, state } = applyVideoOverlayRectChange(selections, overlayIndex, next);
    pushChange(label, state);
  }

  // VideoOverlayTrack's edge-drag (trim) and body-drag (move) gestures.
  function handleChangeVideoOverlayRange(overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) {
    setLiveVideoOverlayRangeEdit({ index: overlayIndex, startTimeSeconds, endTimeSeconds });
  }

  function handleCommitVideoOverlayRange(overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) {
    setLiveVideoOverlayRangeEdit(null);
    const { label, state } = applyVideoOverlayRangeChange(selections, overlayIndex, startTimeSeconds, endTimeSeconds);
    pushChange(label, state);
  }

  function handleChangeVideoOverlayPosition(overlayIndex: number, startTimeSeconds: number) {
    setLiveVideoOverlayPositionEdit({ index: overlayIndex, startTimeSeconds });
  }

  function handleCommitVideoOverlayPosition(overlayIndex: number, startTimeSeconds: number) {
    setLiveVideoOverlayPositionEdit(null);
    const { label, state } = applyVideoOverlayPositionChange(selections, overlayIndex, startTimeSeconds);
    pushChange(label, state);
  }

  function handleDeleteVideoOverlay(overlayIndex: number) {
    setLiveVideoOverlayRectEdit((prev) => (prev?.index === overlayIndex ? null : prev));
    setLiveVideoOverlayRangeEdit((prev) => (prev?.index === overlayIndex ? null : prev));
    setLiveVideoOverlayPositionEdit((prev) => (prev?.index === overlayIndex ? null : prev));
    setLiveOverlayAudioBalanceEdit((prev) => (prev?.index === overlayIndex ? null : prev));
    if (framingDialogOverlayIndex === overlayIndex) setFramingDialogOverlayIndex(null);
    if (sourceStartDialogOverlayIndex === overlayIndex) setSourceStartDialogOverlayIndex(null);
    const { label, state } = applyDeleteVideoOverlay(selections, overlayIndex);
    pushChange(label, state);
  }

  // VideoOverlayTrack's own per-segment volume slider.
  function handleChangeOverlayAudioBalance(overlayIndex: number, balance: number) {
    setLiveOverlayAudioBalanceEdit({ index: overlayIndex, balance });
  }

  function handleCommitOverlayAudioBalance(overlayIndex: number, balance: number) {
    setLiveOverlayAudioBalanceEdit(null);
    const { label, state } = applyChangeOverlayAudioBalance(selections, overlayIndex, balance);
    pushChange(label, state);
  }

  // TtsOverlayTrack's own body drag (move) and volume badge.
  function handleChangeTtsOverlayPosition(overlayIndex: number, startTimeSeconds: number) {
    setLiveTtsOverlayPositionEdit({ index: overlayIndex, startTimeSeconds });
  }

  function handleCommitTtsOverlayPosition(overlayIndex: number, startTimeSeconds: number) {
    setLiveTtsOverlayPositionEdit(null);
    const { label, state } = applyTtsOverlayPositionChange(selections, overlayIndex, startTimeSeconds);
    pushChange(label, state);
  }

  function handleChangeTtsOverlayVolume(overlayIndex: number, volume: number) {
    setLiveTtsOverlayVolumeEdit({ index: overlayIndex, volume });
  }

  function handleCommitTtsOverlayVolume(overlayIndex: number, volume: number) {
    setLiveTtsOverlayVolumeEdit(null);
    const { label, state } = applyTtsOverlayVolumeChange(selections, overlayIndex, volume);
    pushChange(label, state);
  }

  // VideoOverlayTrack's crosshair button -- opens VideoOverlayFramingDialog
  // for that overlay.
  function handleOpenVideoOverlayFraming(overlayIndex: number) {
    setFramingDialogOverlayIndex(overlayIndex);
  }

  function handleCloseVideoOverlayFramingDialog() {
    setFramingDialogOverlayIndex(null);
  }

  // VideoOverlayFramingDialog's "Remove Overlay" -- same delete path as the
  // track's own right-click menu, just reachable from inside the dialog too.
  function handleDeleteFramingDialogOverlay() {
    if (framingDialogOverlayIndex === null) return;
    handleDeleteVideoOverlay(framingDialogOverlayIndex);
  }

  // VideoOverlayFramingDialog's "Save" -- one commit, no live/commit split
  // (see applyChangeOverlayFraming's own comment). `baseFraming`/`ratio`
  // are only ever passed for a Split-Screen overlay, whose popup shows both
  // halves and their divider.
  function handleSaveVideoOverlayFraming(
    framing: OverlayFraming,
    options?: { baseFraming?: OverlayFraming; ratio?: number; audioBalance?: number; rect?: CropRect }
  ) {
    if (framingDialogOverlayIndex === null) return;
    const { label, state } = applyChangeOverlayFraming(selections, framingDialogOverlayIndex, framing, options);
    pushChange(label, state);
    setFramingDialogOverlayIndex(null);
  }

  // ImageOverlayTrack's right-click "Switch to..." entries -- image-overlay
  // mirror of handleChangeVideoOverlayLayout above.
  function handleChangeImageOverlayLayout(
    overlayIndex: number,
    layoutType: VideoOverlayLayout["type"],
    splitScreenOrientation?: "horizontal" | "vertical"
  ) {
    const { label, state } = applyChangeImageOverlayLayout(selections, overlayIndex, layoutType, splitScreenOrientation);
    pushChange(label, state);
  }

  function handleToggleImageSplitScreenOrientation(overlayIndex: number) {
    const { label, state } = applyToggleImageSplitScreenOrientation(selections, overlayIndex);
    pushChange(label, state);
  }

  function handleToggleImageSplitScreenSides(overlayIndex: number) {
    const { label, state } = applyToggleImageSplitScreenSides(selections, overlayIndex);
    pushChange(label, state);
  }

  // ImageOverlayTrack's edge-drag (trim) and body-drag (move) gestures --
  // mirror of the video-overlay pair above.
  function handleChangeImageOverlayRange(overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) {
    setLiveOverlayRangeEdit({ index: overlayIndex, startTimeSeconds, endTimeSeconds });
  }

  function handleCommitImageOverlayRange(overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) {
    setLiveOverlayRangeEdit(null);
    const { label, state } = applyImageOverlayRangeChange(selections, overlayIndex, startTimeSeconds, endTimeSeconds);
    pushChange(label, state);
  }

  function handleChangeImageOverlayPosition(overlayIndex: number, startTimeSeconds: number) {
    setLiveOverlayPositionEdit({ index: overlayIndex, startTimeSeconds });
  }

  function handleCommitImageOverlayPosition(overlayIndex: number, startTimeSeconds: number) {
    setLiveOverlayPositionEdit(null);
    const { label, state } = applyImageOverlayPositionChange(selections, overlayIndex, startTimeSeconds);
    pushChange(label, state);
  }

  function handleDeleteImageOverlay(overlayIndex: number) {
    setLiveOverlayRectEdit((prev) => (prev?.index === overlayIndex ? null : prev));
    setLiveOverlayRangeEdit((prev) => (prev?.index === overlayIndex ? null : prev));
    setLiveOverlayPositionEdit((prev) => (prev?.index === overlayIndex ? null : prev));
    if (imageFramingDialogOverlayIndex === overlayIndex) setImageFramingDialogOverlayIndex(null);
    const { label, state } = applyDeleteImageOverlay(selections, overlayIndex);
    pushChange(label, state);
  }

  // ImageOverlayTrack's crosshair button -- opens ImageOverlayFramingDialog
  // for that overlay, mirror of handleOpenVideoOverlayFraming above.
  function handleOpenImageOverlayFraming(overlayIndex: number) {
    setImageFramingDialogOverlayIndex(overlayIndex);
  }

  function handleCloseImageOverlayFramingDialog() {
    setImageFramingDialogOverlayIndex(null);
  }

  function handleDeleteImageFramingDialogOverlay() {
    if (imageFramingDialogOverlayIndex === null) return;
    handleDeleteImageOverlay(imageFramingDialogOverlayIndex);
  }

  function handleSaveImageOverlayFraming(
    framing: OverlayFraming,
    options?: { baseFraming?: OverlayFraming; ratio?: number; rect?: CropRect }
  ) {
    if (imageFramingDialogOverlayIndex === null) return;
    const { label, state } = applyChangeImageOverlayFraming(selections, imageFramingDialogOverlayIndex, framing, options);
    pushChange(label, state);
    setImageFramingDialogOverlayIndex(null);
  }

  // MarkerTrack's click-to-place/drag/rename/delete on the main sequence's
  // own timeline -- cosmetic (see this file's own `markers` state comment),
  // so these just update plain state and let the debounced-save effect
  // below persist it, no pushChange/history involved.
  function handleAddMarker(timeSeconds: number) {
    setMarkers((prev) => [...prev, { timeSeconds, label: DEFAULT_MARKER_LABEL }]);
  }
  function handleMoveMarker(index: number, timeSeconds: number) {
    setMarkers((prev) => prev.map((marker, i) => (i === index ? { ...marker, timeSeconds } : marker)));
  }
  function handleRenameMarker(index: number, label: string) {
    setMarkers((prev) => prev.map((marker, i) => (i === index ? { ...marker, label } : marker)));
  }
  function handleDeleteMarker(index: number) {
    setMarkers((prev) => prev.filter((_, i) => i !== index));
  }
  function handleTogglePinMarker(index: number) {
    setMarkers((prev) => prev.map((marker, i) => (i === index ? { ...marker, pinned: !marker.pinned } : marker)));
  }

  // The flag icon on a VideoOverlayTrack segment -- opens
  // OverlaySourceStartDialog for that specific overlay placement, by index
  // (see sourceStartDialogOverlayIndex's own state comment for why not
  // assetId).
  function handleOpenOverlaySourceStart(overlayIndex: number) {
    setSourceStartDialogOverlayIndex(overlayIndex);
  }
  function handleCloseOverlaySourceStartDialog() {
    setSourceStartDialogOverlayIndex(null);
  }
  // OverlaySourceStartDialog's "Save" -- one commit, no live/commit split
  // (see applyChangeVideoOverlaySourceStart's own comment).
  function handleSaveOverlaySourceStart(sourceStartSeconds: number) {
    if (sourceStartDialogOverlayIndex === null) return;
    const overlay = selections.videoOverlays[sourceStartDialogOverlayIndex];
    const sourceDurationSeconds = overlay ? overlaySourceDurationSeconds[overlay.assetId] ?? Infinity : Infinity;
    const { label, state } = applyChangeVideoOverlaySourceStart(
      selections,
      sourceStartDialogOverlayIndex,
      sourceStartSeconds,
      sourceDurationSeconds
    );
    pushChange(label, state);
    setSourceStartDialogOverlayIndex(null);
  }

  // "Cutaway" button in UserActions -- opens CutawayDialog fresh, to add a
  // new cutaway (editingCutaway is already null here, never set except by
  // handleEditCutaway below).
  function handleOpenCutawayDialog() {
    setIsCutawayDialogOpen(true);
  }

  function handleCloseCutawayDialog() {
    setIsCutawayDialogOpen(false);
    setEditingCutaway(null);
    setCutawayDialogPreselectedAssetId(null);
  }

  // AssetGallery's right-click "Cutaway" on an IMAGE asset -- opens
  // CutawayDialog fresh (add mode), with that photo pre-selected instead of
  // defaulting to the first one in the project.
  function handleOpenCutawayDialogForAsset(asset: Asset) {
    setCutawayDialogPreselectedAssetId(asset.id);
    setIsCutawayDialogOpen(true);
  }

  // The Cutaways rail's own click (CutawayTrack's onEdit) -- image segments
  // only (see CutawayTrack.tsx). Reopens CutawayDialog pre-filled with that
  // cutaway's current photo/template/duration, so
  // handleAddImageSequenceClip below edits it in place instead of appending
  // a duplicate.
  function handleEditCutaway(segment: CutawaySegment) {
    if (segment.kind !== "image") return;
    setEditingCutaway(segment);
    setIsCutawayDialogOpen(true);
  }

  // CutawayDialog's image-kind "Add cutaway" / "Save changes" -- appends a
  // new image clip (animated via the chosen, possibly-combined Ken Burns
  // template(s)) to the end of the sequence, or, when editingCutaway is
  // set, edits that existing cutaway's photo/template(s)/duration/crop in
  // place instead. Either way the clip and its ZoomEffect land in ONE
  // history entry (applyAddImageSequenceClip / applyEditImageSequenceClip),
  // so undo reverts both together. `videoDurationSeconds` (already tracked
  // from the extraction effect above) is the sequence's current total
  // length, i.e. exactly where a freshly-added clip starts. `cropRect` is
  // the clip rectangle the dialog's own preview positioned for this
  // specific photo, not the project's video-frame cropRect.
  function handleAddImageSequenceClip(assetId: string, durationSeconds: number, templateIds: string[], cropRect: CropRect) {
    const { label, state } =
      editingCutaway && editingCutaway.kind === "image"
        ? applyEditImageSequenceClip(
            selections,
            editingCutaway.entryId,
            assetId,
            durationSeconds,
            templateIds,
            cropRect,
            editingCutaway.startTimeSeconds
          )
        : applyAddImageSequenceClip(selections, assetId, durationSeconds, templateIds, cropRect, videoDurationSeconds);
    pushChange(label, state);
    setIsCutawayDialogOpen(false);
    setEditingCutaway(null);
    setCutawayDialogPreselectedAssetId(null);
  }

  // "Remove Cutaway" -- from CutawayTrack's own right-click menu (every
  // clip in the sequence now, video or image), or CutawayDialog's delete
  // button when reopened in edit mode (image only). Splices the clip out of
  // the sequence (applyDeleteSequenceClip), closing the dialog first if it
  // was the one being edited. `durationSeconds` comes off the segment
  // itself -- CutawayTrack's own builder (FrameStrip.tsx) derives it from
  // real clip-boundary positions for both kinds, not just an image entry's
  // authored field.
  function handleDeleteCutaway(segment: CutawaySegment) {
    if (editingCutaway?.entryId === segment.entryId) {
      setIsCutawayDialogOpen(false);
      setEditingCutaway(null);
    }
    const { label, state } = applyDeleteSequenceClip(selections, segment.entryId, segment.durationSeconds, segment.startTimeSeconds);
    pushChange(label, state);
  }

  // FrameStrip's post-add drag handle on an image clip's boundary --
  // `clipStartSeconds` comes from the caller's own resolved playbackClips
  // (which has real elapsed-seconds positions, accounting for any
  // preceding video clips' actual probed durations -- see
  // applyResizeImageClip's own comment on why this can't be recomputed
  // from `selections` alone).
  function handleResizeImageClip(entryId: string, newDurationSeconds: number, clipStartSeconds: number) {
    const { label, state } = applyResizeImageClip(selections, entryId, newDurationSeconds, clipStartSeconds);
    pushChange(label, state);
  }

  // Right-click "Add" on a music asset in AssetGallery -- appends it to
  // the background-music sequence (multiple appended tracks concatenate,
  // then the whole thing loops across the video's duration -- see
  // BackgroundTrackStrip). Mutually exclusive with the curated catalog
  // choice; cosmetic/not history-tracked, like the catalog choice.
  function handleAddToBackgroundSequence(asset: Asset) {
    setBackgroundSequenceAssetIds((prev) => [...prev, asset.id]);
    setSelectedBackgroundTrackId("none");
  }

  // Image overlay's own Picture-in-Picture box, dragged via the reused
  // OverlayRectOverlay handles on FrameStrip's active tile -- mirror of
  // handleChangeVideoOverlayRect/handleCommitVideoOverlayRect above.
  function handleChangeImageOverlayRect(overlayIndex: number, next: CropRect) {
    setLiveOverlayRectEdit({ index: overlayIndex, rect: next });
  }

  function handleCommitImageOverlayRect(overlayIndex: number, next: CropRect) {
    setLiveOverlayRectEdit(null);
    const { label, state } = applyImageOverlayRectChange(selections, overlayIndex, next);
    pushChange(label, state);
  }

  // "Text" button in UserActions -- opens the dialog fresh (no pre-fill).
  function handleOpenTextDialog() {
    setEditingTextOverlayIndex(null);
    setIsTextDialogOpen(true);
  }

  // TextOverlayTrack's "Edit text" -- reopens the dialog pre-filled.
  function handleRequestEditTextOverlay(overlayIndex: number) {
    setEditingTextOverlayIndex(overlayIndex);
    setIsTextDialogOpen(true);
  }

  function handleCloseTextDialog() {
    setIsTextDialogOpen(false);
    setEditingTextOverlayIndex(null);
  }

  // TextOverlayDialog's Add/Save -- dispatches to add-new or edit-existing
  // depending on whether it was opened via handleOpenTextDialog or
  // handleRequestEditTextOverlay. `rect` comes from the dialog's own
  // draggable preview (positioned live against the actual current frame),
  // not a fixed default -- see TextOverlayDialog.tsx.
  function handleSaveTextOverlay(text: string, templateId: string, rect: CropRect) {
    const { label, state } =
      editingTextOverlayIndex !== null
        ? applyEditTextOverlay(selections, editingTextOverlayIndex, text, templateId, rect)
        : applyAddTextOverlay(selections, text, templateId, currentTimeSeconds, videoDurationSeconds, rect);
    pushChange(label, state);
    setIsTextDialogOpen(false);
    setEditingTextOverlayIndex(null);
  }

  function handleOpenTranscriptDialog() {
    setIsTranscriptDialogOpen(true);
  }

  function handleCloseTranscriptDialog() {
    setIsTranscriptDialogOpen(false);
  }

  // TranscriptCaptionDialog's Enable/Update -- dispatches based on whether
  // auto-captions are already on, same pattern as handleSaveTextOverlay.
  function handleSaveTranscriptCaption(templateId: string, rect: CropRect) {
    const { label, state } = selections.transcriptCaption
      ? applyUpdateTranscriptCaption(selections, templateId, rect)
      : applyEnableTranscriptCaption(selections, templateId, rect);
    pushChange(label, state);
    setIsTranscriptDialogOpen(false);
  }

  function handleDisableTranscriptCaption() {
    const { label, state } = applyDisableTranscriptCaption(selections);
    pushChange(label, state);
    setIsTranscriptDialogOpen(false);
  }

  function handleChangeTextOverlayRect(overlayIndex: number, next: CropRect) {
    setLiveTextOverlayRectEdit({ index: overlayIndex, rect: next });
  }

  function handleCommitTextOverlayRect(overlayIndex: number, next: CropRect) {
    setLiveTextOverlayRectEdit(null);
    const { label, state } = applyTextOverlayRectCommit(selections, overlayIndex, next);
    pushChange(label, state);
  }

  function handleChangeTextOverlayRange(overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) {
    setLiveTextOverlayRangeEdit({ index: overlayIndex, startTimeSeconds, endTimeSeconds });
  }

  function handleCommitTextOverlayRange(overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) {
    setLiveTextOverlayRangeEdit(null);
    const { label, state } = applyTextOverlayRangeChange(selections, overlayIndex, startTimeSeconds, endTimeSeconds);
    pushChange(label, state);
  }

  function handleDeleteTextOverlay(overlayIndex: number) {
    setLiveTextOverlayRectEdit((prev) => (prev?.index === overlayIndex ? null : prev));
    setLiveTextOverlayRangeEdit((prev) => (prev?.index === overlayIndex ? null : prev));
    const { label, state } = applyDeleteTextOverlay(selections, overlayIndex);
    pushChange(label, state);
  }

  // "TTS" button in UserActions -- opens the dialog fresh (no pre-fill).
  function handleOpenTtsDialog() {
    setEditingTtsOverlayIndex(null);
    setIsTtsDialogOpen(true);
  }

  // ActiveTransformationsList's own narration row -- reopens the dialog
  // pre-filled (mirrors handleRequestEditTextOverlay).
  function handleRequestEditTtsOverlay(overlayIndex: number) {
    setEditingTtsOverlayIndex(overlayIndex);
    setIsTtsDialogOpen(true);
  }

  function handleCloseTtsDialog() {
    setIsTtsDialogOpen(false);
    setEditingTtsOverlayIndex(null);
  }

  // A TTS narration's audio is a freshly-synthesized asset unique to that
  // one overlay -- unlike overlayImages/videoOverlays, which point at assets
  // the user picked from their own uploads and may still want kept around,
  // nothing else creates a TTS asset. Regenerating (handleSaveTtsOverlay) or
  // removing (handleDeleteTtsOverlay) an overlay therefore orphans its old
  // audio unless something deletes it -- but a generated narration clip CAN
  // end up reused on the background-music rail too, via AssetGallery's own
  // "Add" action on an audio-kind asset (see that file's renderTile), so
  // this only deletes once nothing else -- another tts overlay, or the
  // background sequence -- still points at it.
  function cleanupOrphanedTtsAsset(assetId: string, nextState: EditSelectionsSnapshot) {
    const stillReferenced =
      nextState.ttsOverlays.some((overlay) => overlay.assetId === assetId) ||
      backgroundSequenceAssetIds.includes(assetId);
    if (stillReferenced) return;
    setAssets((prev) => prev.filter((asset) => asset.id !== assetId));
    void deleteAsset(assetId).catch(() => {
      // Best-effort -- an orphaned asset left behind on failure is a
      // storage-cost nit, not worth surfacing as a page-level error for an
      // edit the user already sees succeed.
    });
  }

  // TtsOverlayDialog's Add/Save -- the dialog itself already assembled the
  // whole TtsOverlay (script, voice, synthesis result, mode, template,
  // rect, position -- see that file's own module comment), so this just
  // dispatches to add-new or replace-existing and pushes one history entry,
  // same shape as handleSaveTextOverlay. Also kicks off a fresh assets
  // fetch (fire-and-forget): the backend persists the newly-synthesized
  // narration as a real project asset, but this component's own
  // `assets`/`assetUrlById` won't know about it until the next refresh --
  // without this, CanvasPlayer's live preview would show no narration audio
  // until *something else* happened to trigger a refetch.
  //
  // Deliberately merges in only the asset(s) missing from state, rather
  // than calling refreshAssets() (which does a wholesale setAssets(data)).
  // listAssets() re-signs every asset's URL on every call even when the
  // underlying file hasn't changed (same fact handleLocalRenderClick's own
  // comment above relies on), so a wholesale replace would change the URL
  // string of the main video clip too -- flipping CanvasPlayer's clipsKey
  // and reloading the live preview for an edit that never touched that clip.
  function handleSaveTtsOverlay(overlay: TtsOverlay) {
    const previousOverlay = editingTtsOverlayIndex !== null ? selections.ttsOverlays[editingTtsOverlayIndex] : null;
    const { label, state } =
      editingTtsOverlayIndex !== null
        ? applyEditTtsOverlay(selections, editingTtsOverlayIndex, overlay)
        : applyAddTtsOverlay(selections, overlay);
    pushChange(label, state);
    setIsTtsDialogOpen(false);
    setEditingTtsOverlayIndex(null);
    // Regenerating speech for an existing overlay swaps in a brand-new
    // assetId (see TtsOverlayDialog's handleGenerateSpeech) -- the old audio
    // is no longer this overlay's, so clear it out unless it's still doing
    // double duty somewhere else.
    if (previousOverlay && previousOverlay.assetId !== overlay.assetId) {
      cleanupOrphanedTtsAsset(previousOverlay.assetId, state);
    }
    void listAssets(projectId)
      .then((data) => {
        setAssets((prev) => {
          const existingIds = new Set(prev.map((asset) => asset.id));
          const newAssets = data.filter((asset) => !existingIds.has(asset.id));
          return newAssets.length > 0 ? [...prev, ...newAssets] : prev;
        });
      })
      .catch(() => {
        // Best-effort -- same as refreshAssets() elsewhere, not worth
        // surfacing a failed background refetch as a page-level error.
      });
  }

  function handleDeleteTtsOverlay(overlayIndex: number) {
    const deletedOverlay = selections.ttsOverlays[overlayIndex];
    if (editingTtsOverlayIndex === overlayIndex) {
      setIsTtsDialogOpen(false);
      setEditingTtsOverlayIndex(null);
    }
    setLiveTtsOverlayPositionEdit((prev) => (prev?.index === overlayIndex ? null : prev));
    setLiveTtsOverlayVolumeEdit((prev) => (prev?.index === overlayIndex ? null : prev));
    const { label, state } = applyDeleteTtsOverlay(selections, overlayIndex);
    pushChange(label, state);
    if (deletedOverlay) cleanupOrphanedTtsAsset(deletedOverlay.assetId, state);
  }

  function handleSeek(seconds: number) {
    canvasPlayerRef.current?.seekTo(seconds);
  }

  // Splices the in-progress drag (if any) into the persisted array at its
  // own index -- everything else in the array is unaffected, only the one
  // effect being dragged shows its live position.
  const displayedZoomEffects = liveZoomEffectEdit
    ? selections.zoomEffects.map((effect, index) => (index === liveZoomEffectEdit.index ? liveZoomEffectEdit.effect : effect))
    : selections.zoomEffects;

  const frameAspectRatio = frameDimensions ? frameDimensions.width / frameDimensions.height : null;

  // The thumbnail closest to the current playhead -- what TextOverlayDialog
  // shows behind the draggable text rect, so positioning a caption happens
  // against the actual frame it'll appear on rather than a blank/undersized
  // guess. Same instant a freshly-added overlay starts at (see
  // applyAddTextOverlay's currentTimeSeconds), so "what you see while
  // placing it" and "when it first appears" are the same frame.
  const previewFrameIndex = findClosestTimestampIndex(thumbnailTimestampsSeconds, currentTimeSeconds);
  const previewFrameUrl = previewFrameIndex >= 0 ? thumbnails[previewFrameIndex] : null;

  // FilterPresetDialog's own preview frame, per target -- unlike
  // previewFrameUrl above (always the base track's frame at the CURRENT
  // PLAYHEAD, wherever that happens to be), each of these shows a frame
  // that actually belongs to the clip/image the dialog is about to filter:
  // an image cutaway/overlay's own photo (constant for its whole duration,
  // so the playhead's position relative to it is irrelevant), a video
  // cutaway's own frame at ITS OWN midpoint (it may be nowhere near the
  // current playhead), or a video overlay's own thumbnail (its marked
  // start-point frame if set, else its generic per-asset frame) -- the same
  // source CanvasPlayer's live filter preview draws for that same clip.
  // Without this, hovering a swatch while editing e.g. a cutaway elsewhere
  // on the timeline previewed the filter against whatever frame the
  // playhead was sitting on instead of the cutaway's own footage.
  const filterDialogCutawayPreviewFrameUrl = filterDialogCutaway
    ? filterDialogCutaway.kind === "image"
      ? (assetUrlById[filterDialogCutaway.assetId] ?? null)
      : (() => {
          const midpoint = filterDialogCutaway.startTimeSeconds + filterDialogCutaway.durationSeconds / 2;
          const index = findClosestTimestampIndex(thumbnailTimestampsSeconds, midpoint);
          return index >= 0 ? thumbnails[index] : null;
        })()
    : null;

  // CutTransitionDialog's own two preview frames -- the outgoing clip's TAIL
  // (near its own end) and the incoming clip's HEAD (near its own start),
  // rather than either clip's midpoint, so the preview shows something
  // closer to what the actual cut looks like. `transitionDialogEntry` is
  // always the INCOMING clip (see this file's own state comment); its
  // outgoing neighbor is simply whichever entry precedes it in
  // effectiveSequenceEntries -- always defined, since FrameStrip's boundary
  // badge never opens this dialog for the very first clip (nothing precedes
  // it -- see video_math.ts's SequenceEntry.cutTransitionInId doc comment).
  const transitionDialogIncomingIndex = transitionDialogEntry
    ? effectiveSequenceEntries.findIndex((entry) => entry.id === transitionDialogEntry.id)
    : -1;
  function frameUrlNear(entry: SequenceEntry | undefined, index: number, biasTowardStart: boolean): string | null {
    if (!entry) return null;
    if (entry.kind === "image") return assetUrlById[entry.assetId] ?? null;
    const startTimeSeconds = index === 0 ? 0 : clipBoundarySeconds[index - 1];
    const endTimeSeconds = index < clipBoundarySeconds.length ? clipBoundarySeconds[index] : videoDurationSeconds;
    const bias = (endTimeSeconds - startTimeSeconds) * 0.1;
    const targetSeconds = biasTowardStart ? startTimeSeconds + bias : endTimeSeconds - bias;
    const frameIndex = findClosestTimestampIndex(thumbnailTimestampsSeconds, targetSeconds);
    return frameIndex >= 0 ? thumbnails[frameIndex] : null;
  }
  const transitionDialogOutgoingFrameUrl =
    transitionDialogIncomingIndex > 0
      ? frameUrlNear(effectiveSequenceEntries[transitionDialogIncomingIndex - 1], transitionDialogIncomingIndex - 1, false)
      : null;
  const transitionDialogIncomingFrameUrl =
    transitionDialogIncomingIndex >= 0 ? frameUrlNear(transitionDialogEntry ?? undefined, transitionDialogIncomingIndex, true) : null;

  const filterDialogImageOverlayPreviewFrameUrl =
    filterDialogImageOverlayIndex !== null
      ? (assetUrlById[selections.overlayImages[filterDialogImageOverlayIndex]?.assetId ?? ""] ?? null)
      : null;

  const filterDialogVideoOverlayTarget =
    filterDialogVideoOverlayIndex !== null ? (selections.videoOverlays[filterDialogVideoOverlayIndex] ?? null) : null;
  const filterDialogVideoOverlayPreviewFrameUrl = filterDialogVideoOverlayTarget
    ? (videoOverlayStartThumbnailByKey[
        videoOverlayStartThumbnailKey(filterDialogVideoOverlayTarget.assetId, filterDialogVideoOverlayTarget.sourceStartSeconds)
      ] ??
      videoThumbnailUrlByAssetId[filterDialogVideoOverlayTarget.assetId] ??
      null)
    : null;

  // Splices any in-progress rect/range/position drag into the persisted
  // array at its own index, same pattern as displayedVideoOverlays below --
  // a rect edit only ever applies to a Picture-in-Picture layout (the only
  // one with a rect), checked defensively even though the UI never offers
  // one for any other layout.
  const displayedOverlayImages: ImageOverlayClip[] = selections.overlayImages.map((overlay, index) => {
    if (liveOverlayRangeEdit?.index === index) {
      return {
        ...overlay,
        startTimeSeconds: liveOverlayRangeEdit.startTimeSeconds,
        endTimeSeconds: liveOverlayRangeEdit.endTimeSeconds,
      };
    }
    if (liveOverlayPositionEdit?.index === index) {
      const duration = overlay.endTimeSeconds - overlay.startTimeSeconds;
      return { ...overlay, startTimeSeconds: liveOverlayPositionEdit.startTimeSeconds, endTimeSeconds: liveOverlayPositionEdit.startTimeSeconds + duration };
    }
    if (liveOverlayRectEdit?.index === index && overlay.layout.type === "picture-in-picture") {
      return { ...overlay, layout: { ...overlay.layout, rect: liveOverlayRectEdit.rect } };
    }
    return overlay;
  });

  const displayedTextOverlays: TextOverlay[] = selections.textOverlays.map((overlay, index) => {
    if (liveTextOverlayRectEdit?.index === index) return { ...overlay, rect: liveTextOverlayRectEdit.rect };
    if (liveTextOverlayRangeEdit?.index === index) {
      return {
        ...overlay,
        startTimeSeconds: liveTextOverlayRangeEdit.startTimeSeconds,
        endTimeSeconds: liveTextOverlayRangeEdit.endTimeSeconds,
      };
    }
    return overlay;
  });

  // Splices any in-progress rect/range/position drag into the persisted
  // array at its own index, same pattern as displayedOverlayImages above --
  // a rect edit only ever applies to a Picture-in-Picture layout (the only
  // one with a rect), checked defensively even though the UI never offers
  // one for any other layout.
  const displayedVideoOverlays: VideoOverlayClip[] = selections.videoOverlays.map((overlay, index) => {
    if (liveVideoOverlayRangeEdit?.index === index) {
      return { ...overlay, startTimeSeconds: liveVideoOverlayRangeEdit.startTimeSeconds, endTimeSeconds: liveVideoOverlayRangeEdit.endTimeSeconds };
    }
    if (liveVideoOverlayPositionEdit?.index === index) {
      const duration = overlay.endTimeSeconds - overlay.startTimeSeconds;
      return { ...overlay, startTimeSeconds: liveVideoOverlayPositionEdit.startTimeSeconds, endTimeSeconds: liveVideoOverlayPositionEdit.startTimeSeconds + duration };
    }
    if (liveVideoOverlayRectEdit?.index === index && overlay.layout.type === "picture-in-picture") {
      return { ...overlay, layout: { ...overlay.layout, rect: liveVideoOverlayRectEdit.rect } };
    }
    if (liveOverlayAudioBalanceEdit?.index === index) {
      return { ...overlay, audioBalance: liveOverlayAudioBalanceEdit.balance };
    }
    return overlay;
  });

  // Splices any in-progress TtsOverlayTrack drag/volume edit into the
  // persisted array at its own index, same pattern as displayedVideoOverlays
  // above.
  const displayedTtsOverlays: TtsOverlay[] = selections.ttsOverlays.map((overlay, index) => {
    if (liveTtsOverlayPositionEdit?.index === index) {
      return { ...overlay, startTimeSeconds: liveTtsOverlayPositionEdit.startTimeSeconds };
    }
    if (liveTtsOverlayVolumeEdit?.index === index) {
      return { ...overlay, volume: liveTtsOverlayVolumeEdit.volume };
    }
    return overlay;
  });

  // Every asset currently referenced by at least one overlay, in the video
  // sequence, or in the background-music sequence -- drives AssetGallery's
  // "+" in-use badge.
  const usedAssetIds = new Set([
    ...selections.overlayImages.map((overlay) => overlay.assetId),
    ...selections.sequenceClips.map((entry) => entry.assetId),
    ...selections.videoOverlays.map((overlay) => overlay.assetId),
    ...backgroundSequenceAssetIds,
  ]);

  // Resolves the background-music sequence into the ordered
  // {assetId, name, url} list BackgroundTrackStrip needs to visualize
  // (concatenated, then looped across the video's duration) and
  // handleRenderClick needs to compile -- a project asset sequence takes
  // precedence over the curated catalog entry, if any. `assetId` is null
  // for a catalog track (no project asset backing it, so nothing for a
  // render to resolve a fresh URL from) -- see gatherRenderClips.ts's own
  // comment on why that case is skipped at render time today.
  const backgroundAssetTracks = backgroundSequenceAssetIds
    .map((id) => assets.find((asset) => asset.id === id))
    .filter((asset): asset is Asset => Boolean(asset))
    .map((asset) => ({ assetId: asset.id, name: asset.filename, url: asset.url }));
  const backgroundCatalogTrack = BACKGROUND_TRACK_OPTIONS.find((option) => option.id === selectedBackgroundTrackId);
  const resolvedBackgroundTracks =
    backgroundAssetTracks.length > 0
      ? backgroundAssetTracks
      : backgroundCatalogTrack?.url
        ? [{ assetId: null, name: backgroundCatalogTrack.name, url: backgroundCatalogTrack.url }]
        : [];

  // The green Render button in FeedbackArea -- cloud (Creatomate) rendering
  // is temporarily disabled, so this just surfaces a "coming soon" popup
  // instead of gathering clip durations and calling startRender(). The free/
  // local render button (handleLocalRenderClick) is the only one that
  // actually renders for now.
  function handleRenderClick() {
    setIsRenderComingSoonOpen(true);
  }

  // The lighter-green free Render button in FeedbackArea -- renders entirely
  // in this tab (lib/localRender/exportTimeline.ts), no server/Creatomate
  // involved. Mirrors handleRenderClick's own "gather real durations fresh,
  // then compute output dimensions" shape, but via the local-only gatherer
  // (gatherLocalRenderClips.ts) since the local exporter needs each clip's
  // actual URL, not just its duration.
  async function handleLocalRenderClick() {
    if (effectiveSequenceEntries.length === 0 || isLocalRendering) return;

    setIsLocalRenderPopupOpen(true);

    // Re-fetches the asset list right before rendering rather than reusing
    // this component's own (possibly long-since-fetched) `assets`/
    // `assetUrlById` -- presigned URLs expire (r2_signed_url_expires_seconds,
    // backend/src/core/config.py), and a local export can run for a while on
    // a slow connection, so a URL that was still fine when this project was
    // opened can easily expire mid-render otherwise. This is exactly what
    // caused overlay images to silently fail to load partway through a slow
    // export. Mirrors the cloud render's own "resolve fresh URLs right
    // before the actual operation" approach (api/render/route.ts's
    // resolveAssetSources), just done client-side instead of server-side.
    //
    // Deliberately calls listAssets directly instead of refreshAssets() --
    // refreshAssets() also does setAssets(data), and a presigned URL gets a
    // new signature on every fetch even when the underlying file hasn't
    // changed. Routing that through setAssets while a render is in flight
    // would replace assetUrlById's values, which flips CanvasPlayer's
    // clipsKey (CanvasPlayer.tsx) and made the live preview reload itself
    // mid-export. This fetch is only for the exporter's own use, so it must
    // stay out of the state the preview reads from.
    const freshAssets = await listAssets(projectId);
    const freshAssetUrlById = Object.fromEntries(freshAssets.map((asset) => [asset.id, asset.url]));
    const freshSequenceClips = effectiveSequenceEntries.map((entry) => ({ ...entry, url: freshAssetUrlById[entry.assetId] }));
    const freshBackgroundAssetTracks = backgroundSequenceAssetIds
      .map((id) => freshAssets.find((asset) => asset.id === id))
      .filter((asset): asset is Asset => Boolean(asset))
      .map((asset) => ({ assetId: asset.id, name: asset.filename, url: asset.url }));
    const freshResolvedBackgroundTracks =
      freshBackgroundAssetTracks.length > 0
        ? freshBackgroundAssetTracks
        : backgroundCatalogTrack?.url
          ? [{ assetId: null, name: backgroundCatalogTrack.name, url: backgroundCatalogTrack.url }]
          : [];

    const gatheredSequenceClips = await gatherLocalSequenceClips(freshSequenceClips);
    const gatheredBackgroundClips = await gatherLocalBackgroundClips(freshResolvedBackgroundTracks);

    const clipRectOption = CLIP_RECT_OPTIONS.find((option) => option.id === selections.clipRectId);
    const targetRatio = clipRectOption
      ? clipRectOption.widthRatio / clipRectOption.heightRatio
      : (frameAspectRatio ?? 9 / 16);
    const { width, height } = computeOutputDimensions(targetRatio);

    await startLocalRender({
      selections,
      sequenceClips: gatheredSequenceClips,
      backgroundClips: gatheredBackgroundClips,
      assetUrlById: freshAssetUrlById,
      // A single-asset re-resolve for exportTimeline.ts's own mid-render
      // retry (see its loadOverlayImage) -- listAssets is the only lookup
      // this API has (no getAsset(id)), so this just re-fetches the whole
      // list again and picks the one asset out of it. Only ever called after
      // an actual fetch failure, not per-frame, so the extra round trip is
      // cheap relative to what it fixes (a URL that's gone stale between
      // freshAssets above and whenever that specific image's turn came up).
      refreshAssetUrl: async (assetId: string) => {
        try {
          const latest = await listAssets(projectId);
          return latest.find((asset) => asset.id === assetId)?.url;
        } catch {
          return undefined;
        }
      },
      mainAudioVolume,
      backgroundVolume,
      outputWidth: width,
      outputHeight: height,
    });
  }

  const framingDialogOverlay = framingDialogOverlayIndex !== null ? displayedVideoOverlays[framingDialogOverlayIndex] ?? null : null;
  const imageFramingDialogOverlay =
    imageFramingDialogOverlayIndex !== null ? displayedOverlayImages[imageFramingDialogOverlayIndex] ?? null : null;
  const sourceStartDialogOverlay =
    sourceStartDialogOverlayIndex !== null ? displayedVideoOverlays[sourceStartDialogOverlayIndex] ?? null : null;
  const sourceStartDialogAsset = sourceStartDialogOverlay ? assets.find((a) => a.id === sourceStartDialogOverlay.assetId) ?? null : null;
  const sourceStartDialogSourceDurationSeconds = sourceStartDialogOverlay
    ? overlaySourceDurationSeconds[sourceStartDialogOverlay.assetId] ?? Infinity
    : Infinity;

  return (
    // Outer h-full/overflow-x-auto + inner min-w -- the whole editor (top
    // bar, Action Area, Playground, Feedback Area) scrolls horizontally as
    // ONE unit once the window gets narrower than the fixed-width side
    // panels in Action Area (ProjectList/AssetGallery/UserActions/
    // ActiveTransformationsList) need, instead of each section clipping or
    // squeezing its own contents independently (which is what let the video
    // panel get squeezed into distortion on resize -- see CanvasPlayer's
    // own object-contain fix). min-w below is that combined floor: the four
    // fixed panels' own widths (160+224+480+256px) plus Action Area's row
    // gap/padding, plus headroom so the video preview itself never has to
    // shrink to nothing.
    <div className="h-full overflow-x-auto">
      <div className="flex h-full min-w-[1500px] flex-col">
        <TopMenuBar
        canRender={effectiveSequenceEntries.length > 0}
        isRendering={isRendering}
        renderStatus={renderStatus}
        onRenderClick={handleRenderClick}
        canLocalRender={effectiveSequenceEntries.length > 0}
        isLocalRendering={isLocalRendering}
        isLocalRenderSupported={isLocalRenderSupported}
        localRenderUnsupportedReason={localRenderUnsupportedReason}
        onLocalRenderClick={handleLocalRenderClick}
        transcriptCaption={selections.transcriptCaption}
      />

      <section className="min-h-0 flex-[3] overflow-hidden border-b border-border">
        <ActionArea
          projectId={projectId}
          assets={assets}
          assetsLoaded={assetsLoaded}
          selectedAsset={selectedAsset}
          onSelectAsset={setSelectedAsset}
          onUploaded={handleUploaded}
          onUploadingChange={setIsUploading}
          onAssetDeleted={handleAssetDeleted}
          onAddImageOverlay={handleAddImageOverlay}
          onAddToSequence={handleAddToSequence}
          onAddVideoOverlay={handleAddVideoOverlay}
          onAddToBackgroundSequence={handleAddToBackgroundSequence}
          onOpenCutawayDialogForAsset={handleOpenCutawayDialogForAsset}
          usedAssetIds={usedAssetIds}
          videoThumbnailUrlByAssetId={videoThumbnailUrlByAssetId}
          framingDialogOverlay={framingDialogOverlay}
          onSaveVideoOverlayFraming={handleSaveVideoOverlayFraming}
          onCloseVideoOverlayFramingDialog={handleCloseVideoOverlayFramingDialog}
          onDeleteFramingDialogOverlay={handleDeleteFramingDialogOverlay}
          imageFramingDialogOverlay={imageFramingDialogOverlay}
          onSaveImageOverlayFraming={handleSaveImageOverlayFraming}
          onCloseImageOverlayFramingDialog={handleCloseImageOverlayFramingDialog}
          onDeleteImageFramingDialogOverlay={handleDeleteImageFramingDialogOverlay}
          sourceStartDialogOverlay={sourceStartDialogOverlay}
          sourceStartDialogAssetUrl={sourceStartDialogAsset ? assetUrlById[sourceStartDialogAsset.id] ?? "" : ""}
          sourceStartDialogAssetFilename={sourceStartDialogAsset?.filename ?? ""}
          sourceStartDialogSourceDurationSeconds={sourceStartDialogSourceDurationSeconds}
          onSaveOverlaySourceStart={handleSaveOverlaySourceStart}
          onCloseOverlaySourceStartDialog={handleCloseOverlaySourceStartDialog}
          selectedClipRectId={selections.clipRectId}
          onSelectClipRect={handleSelectClipRect}
          filterDialogCutaway={filterDialogCutaway}
          filterDialogVideoOverlayIndex={filterDialogVideoOverlayIndex}
          filterDialogImageOverlayIndex={filterDialogImageOverlayIndex}
          filterDialogCutawayPreviewFrameUrl={filterDialogCutawayPreviewFrameUrl}
          filterDialogVideoOverlayPreviewFrameUrl={filterDialogVideoOverlayPreviewFrameUrl}
          filterDialogImageOverlayPreviewFrameUrl={filterDialogImageOverlayPreviewFrameUrl}
          onSelectCutawayFilter={handleSelectCutawayFilter}
          onSelectVideoOverlayFilter={handleSelectVideoOverlayFilter}
          onSelectImageOverlayFilter={handleSelectImageOverlayFilter}
          onCloseFilterDialog={() => {
            setFilterDialogCutaway(null);
            setFilterDialogVideoOverlayIndex(null);
            setFilterDialogImageOverlayIndex(null);
          }}
          transitionDialogEntry={transitionDialogEntry}
          transitionDialogOutgoingFrameUrl={transitionDialogOutgoingFrameUrl}
          transitionDialogIncomingFrameUrl={transitionDialogIncomingFrameUrl}
          onSelectClipTransition={handleSelectClipTransition}
          onCloseTransitionDialog={() => setTransitionDialogEntry(null)}
          onOpenTextDialog={handleOpenTextDialog}
          isTextDialogOpen={isTextDialogOpen}
          editingTextOverlay={editingTextOverlayIndex !== null ? displayedTextOverlays[editingTextOverlayIndex] : null}
          onSaveTextOverlay={handleSaveTextOverlay}
          onCloseTextDialog={handleCloseTextDialog}
          onOpenTtsDialog={handleOpenTtsDialog}
          isTtsDialogOpen={isTtsDialogOpen}
          editingTtsOverlay={editingTtsOverlayIndex !== null ? (selections.ttsOverlays[editingTtsOverlayIndex] ?? null) : null}
          onSaveTtsOverlay={handleSaveTtsOverlay}
          onCloseTtsDialog={handleCloseTtsDialog}
          onEditTtsOverlay={handleRequestEditTtsOverlay}
          onDeleteTtsOverlay={handleDeleteTtsOverlay}
          onOpenTranscriptDialog={handleOpenTranscriptDialog}
          isTranscriptDialogOpen={isTranscriptDialogOpen}
          transcriptCaption={selections.transcriptCaption}
          onSaveTranscriptCaption={handleSaveTranscriptCaption}
          onDisableTranscriptCaption={handleDisableTranscriptCaption}
          onCloseTranscriptDialog={handleCloseTranscriptDialog}
          onOpenCutawayDialog={handleOpenCutawayDialog}
          isCutawayDialogOpen={isCutawayDialogOpen}
          editingCutaway={editingCutaway}
          cutawayDialogPreselectedAssetId={cutawayDialogPreselectedAssetId}
          onAddImageSequenceClip={handleAddImageSequenceClip}
          onAddVideoSequenceClip={handleAddToSequence}
          onCloseCutawayDialog={handleCloseCutawayDialog}
          onDeleteCutaway={handleDeleteCutaway}
          isVideoOverlayPickerOpen={isVideoOverlayPickerOpen}
          onOpenVideoOverlayPicker={() => setIsVideoOverlayPickerOpen(true)}
          onCloseVideoOverlayPicker={() => setIsVideoOverlayPickerOpen(false)}
          isImageOverlayPickerOpen={isImageOverlayPickerOpen}
          onOpenImageOverlayPicker={() => setIsImageOverlayPickerOpen(true)}
          onCloseImageOverlayPicker={() => setIsImageOverlayPickerOpen(false)}
          previewFrameUrl={previewFrameUrl}
          frameAspectRatio={frameAspectRatio}
          baseCropRect={selections.cropRect}
          zoomEffects={displayedZoomEffects}
          liveCropRectOverride={liveCropRect}
          flipHorizontalToggles={selections.flipHorizontalToggles}
          flipVerticalToggles={selections.flipVerticalToggles}
          trimRanges={selections.trimRanges}
          overlayImages={displayedOverlayImages}
          textOverlays={displayedTextOverlays}
          ttsOverlays={displayedTtsOverlays}
          sequenceClips={playbackClips}
          videoOverlays={displayedVideoOverlays}
          backgroundTracks={resolvedBackgroundTracks}
          mainAudioVolume={mainAudioVolume}
          backgroundVolume={backgroundVolume}
          assetUrlById={assetUrlById}
          onFrameDimensions={setFrameDimensions}
          playerRef={canvasPlayerRef}
          onPlayerTimeUpdate={setCurrentTimeSeconds}
          selections={{
            ...selections,
            zoomEffects: displayedZoomEffects,
            overlayImages: displayedOverlayImages,
            textOverlays: displayedTextOverlays,
            videoOverlays: displayedVideoOverlays,
          }}
          videoDurationSeconds={videoDurationSeconds}
          currentTimeSeconds={currentTimeSeconds}
        />
      </section>

      <section className="min-h-0 flex-[7] overflow-hidden border-b border-border">
        <Playground
          backgroundTracks={resolvedBackgroundTracks}
          videoDurationSeconds={videoDurationSeconds}
          thumbnails={thumbnails}
          thumbnailTimestampsSeconds={thumbnailTimestampsSeconds}
          clipBoundarySeconds={clipBoundarySeconds}
          sequenceEntries={effectiveSequenceEntries}
          onResizeImageClip={handleResizeImageClip}
          onEditCutaway={handleEditCutaway}
          onDeleteCutaway={handleDeleteCutaway}
          onOpenCutawayFilter={handleOpenCutawayFilter}
          onOpenClipTransition={handleOpenClipTransition}
          mainAudioVolume={mainAudioVolume}
          onChangeMainAudioVolume={setMainAudioVolume}
          backgroundVolume={backgroundVolume}
          onChangeBackgroundVolume={setBackgroundVolume}
          isAnalyzing={isAnalyzing}
          currentTimeSeconds={currentTimeSeconds}
          onSeek={handleSeek}
          baseCropRect={selections.cropRect}
          zoomEffects={displayedZoomEffects}
          frameAspectRatio={frameAspectRatio}
          onChangeZoomRange={handleChangeZoomRange}
          onCommitZoomRange={handleCommitZoomRange}
          onChangeZoomEpicenter={handleChangeZoomEpicenter}
          onCommitZoomEpicenter={handleCommitZoomEpicenter}
          onDeleteZoomEffect={handleDeleteZoomEffect}
          onCropRectChange={handleCropRectChange}
          onCropRectCommit={handleCropRectCommit}
          flipHorizontalToggles={selections.flipHorizontalToggles}
          flipVerticalToggles={selections.flipVerticalToggles}
          onFlipHorizontal={() => handleFlip("horizontal")}
          onFlipVertical={() => handleFlip("vertical")}
          trimRanges={selections.trimRanges}
          pendingTrimStartSeconds={pendingTrimStartSeconds}
          onTrimTrackClick={handleTrimTrackClick}
          onMoveTrimDot={setPendingTrimStartSeconds}
          onDeleteTrimRange={handleDeleteTrimRange}
          overlayImages={displayedOverlayImages}
          assetUrlById={assetUrlById}
          onChangeImageOverlayRect={handleChangeImageOverlayRect}
          onCommitImageOverlayRect={handleCommitImageOverlayRect}
          onChangeImageOverlayRange={handleChangeImageOverlayRange}
          onCommitImageOverlayRange={handleCommitImageOverlayRange}
          onChangeImageOverlayPosition={handleChangeImageOverlayPosition}
          onCommitImageOverlayPosition={handleCommitImageOverlayPosition}
          onChangeImageOverlayLayout={handleChangeImageOverlayLayout}
          onToggleImageSplitScreenOrientation={handleToggleImageSplitScreenOrientation}
          onToggleImageSplitScreenSides={handleToggleImageSplitScreenSides}
          onOpenImageOverlayFraming={handleOpenImageOverlayFraming}
          onOpenImageOverlayFilter={handleOpenImageOverlayFilter}
          onDeleteImageOverlay={handleDeleteImageOverlay}
          textOverlays={displayedTextOverlays}
          onChangeTextOverlayRect={handleChangeTextOverlayRect}
          onCommitTextOverlayRect={handleCommitTextOverlayRect}
          onChangeTextOverlayRange={handleChangeTextOverlayRange}
          onCommitTextOverlayRange={handleCommitTextOverlayRange}
          onDeleteTextOverlay={handleDeleteTextOverlay}
          onRequestEditTextOverlay={handleRequestEditTextOverlay}
          ttsOverlays={displayedTtsOverlays}
          onChangeTtsOverlayPosition={handleChangeTtsOverlayPosition}
          onCommitTtsOverlayPosition={handleCommitTtsOverlayPosition}
          onChangeTtsOverlayVolume={handleChangeTtsOverlayVolume}
          onCommitTtsOverlayVolume={handleCommitTtsOverlayVolume}
          onEditTtsOverlay={handleRequestEditTtsOverlay}
          onDeleteTtsOverlay={handleDeleteTtsOverlay}
          videoOverlays={displayedVideoOverlays}
          videoThumbnailUrlByAssetId={videoThumbnailUrlByAssetId}
          videoOverlayStartThumbnailByKey={videoOverlayStartThumbnailByKey}
          overlaySourceDurationSeconds={overlaySourceDurationSeconds}
          onChangeVideoOverlayRect={handleChangeVideoOverlayRect}
          onCommitVideoOverlayRect={handleCommitVideoOverlayRect}
          onChangeVideoOverlayRange={handleChangeVideoOverlayRange}
          onCommitVideoOverlayRange={handleCommitVideoOverlayRange}
          onChangeVideoOverlayPosition={handleChangeVideoOverlayPosition}
          onCommitVideoOverlayPosition={handleCommitVideoOverlayPosition}
          onChangeVideoOverlayLayout={handleChangeVideoOverlayLayout}
          onToggleSplitScreenOrientation={handleToggleSplitScreenOrientation}
          onToggleSplitScreenSides={handleToggleSplitScreenSides}
          onOpenVideoOverlayFraming={handleOpenVideoOverlayFraming}
          onOpenVideoOverlayFilter={handleOpenVideoOverlayFilter}
          onDeleteVideoOverlay={handleDeleteVideoOverlay}
          onChangeOverlayAudioBalance={handleChangeOverlayAudioBalance}
          onCommitOverlayAudioBalance={handleCommitOverlayAudioBalance}
          markers={markers}
          onAddMarker={handleAddMarker}
          onMoveMarker={handleMoveMarker}
          onRenameMarker={handleRenameMarker}
          onDeleteMarker={handleDeleteMarker}
          onTogglePinMarker={handleTogglePinMarker}
          onOpenSourceStart={handleOpenOverlaySourceStart}
        />
      </section>

      <section className="shrink-0 overflow-hidden">
        <FeedbackArea
          assetsError={assetsError}
          analysisError={analysisError}
          saveError={saveError}
          isAnalyzing={isAnalyzing}
          isUploading={isUploading}
          isRendering={isRendering}
          renderStatus={renderStatus}
          renderUrl={renderUrl}
          renderError={renderError}
          isRenderStuck={isRenderStuck}
        />
      </section>

      {isRenderComingSoonOpen && <RenderComingSoonPopup onClose={() => setIsRenderComingSoonOpen(false)} />}
      {isLocalRenderPopupOpen && (
        <LocalRenderPopup
          isRendering={isLocalRendering}
          progress={localRenderProgress}
          resultUrl={localRenderUrl}
          resultMimeType={localRenderMimeType}
          resultError={localRenderError}
          resultWarnings={localRenderWarnings}
          onClose={() => setIsLocalRenderPopupOpen(false)}
        />
      )}
      </div>
    </div>
  );
}
