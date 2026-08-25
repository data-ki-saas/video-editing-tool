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
 * Three fixed horizontal bands per spec: 30% action area, 50% playground,
 * 20% feedback area. This component owns the cross-band state (the full
 * asset list, the video sequence, the frame-affecting edit history,
 * playback position, crop/zoom/flip/trim/overlay/text) and the thumbnail/
 * volume extraction pipeline; each band below is otherwise a plain,
 * mostly-stateless view. It does NOT contain transformation decision logic
 * itself -- see lib/video/transformations.ts for "given the current
 * selections and an action, what's the new state," which this component
 * just calls and pushes through useEditHistory.
 *
 * Template and background-track choices are plain persisted state, not
 * part of the edit history -- they don't change what the frames look like
 * (yet), and the change list (FeedbackArea) is meant to show only actions
 * that do. Everything frame-affecting (clip rectangle, zoom/pan, flip,
 * trim, image/text overlays, and which videos are in the sequence) goes
 * through useEditHistory.
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
import { listAssets, type Asset } from "@/lib/api";
import { extractThumbnails, getVideoDuration, captureSingleFrame } from "@/lib/video/video";
import { extractVolumeProfile } from "@/lib/video/audio";
import {
  generateSampleTimestamps,
  findClosestTimestampIndex,
  computeOutputDimensions,
  type CropRect,
  type OverlayImage,
  type SequenceEntry,
  type TextOverlay,
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
  applyAddOverlayImage,
  applyOverlayRectCommit,
  applyOverlayRangeChange,
  applyDeleteOverlayImage,
  applyAddSequenceClip,
  applyAddImageSequenceClip,
  applyResizeImageClip,
  applyAddTextOverlay,
  applyEditTextOverlay,
  applyTextOverlayRectCommit,
  applyTextOverlayRangeChange,
  applyDeleteTextOverlay,
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
  applyDeleteVideoOverlay,
} from "@/lib/video/transformations";
import { saveTimeline, type Timeline, type EditSelectionsSnapshot, type Project } from "@/lib/projects";
import { useEditHistory } from "@/lib/useEditHistory";
import { useRenderStatus } from "@/lib/useRenderStatus";
import { useLocalRender } from "@/lib/useLocalRender";
import { gatherLocalSequenceClips, gatherLocalBackgroundClips } from "@/lib/localRender/gatherLocalRenderClips";
import { CLIP_RECT_OPTIONS } from "./ClipRectIcon";
import { BACKGROUND_TRACK_OPTIONS } from "@/lib/backgroundTracks";
import { ActionArea } from "./ActionArea";
import { Playground } from "./Playground";
import { FeedbackArea } from "./FeedbackArea";
import type { CanvasPlayerHandle } from "./CanvasPlayer";
import { RenderComingSoonPopup } from "./RenderComingSoonPopup";
import { LocalRenderPopup } from "./LocalRenderPopup";

const THUMBNAIL_INTERVAL_SECONDS = 1;
const VOLUME_BUCKET_SECONDS = 1;
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
  const [volumeLevels, setVolumeLevels] = useState<number[]>([]);
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
  // OverlayTrack segment edges, before it's committed -- same split again.
  const [liveOverlayRangeEdit, setLiveOverlayRangeEdit] = useState<{
    index: number;
    startTimeSeconds: number;
    endTimeSeconds: number;
  } | null>(null);

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

  // TextOverlayDialog's open/edit-target state -- null editingTextOverlayIndex
  // means "Add" (a fresh overlay); otherwise it's pre-filled for editing
  // that existing overlay's text/template.
  const [isTextDialogOpen, setIsTextDialogOpen] = useState(false);
  const [editingTextOverlayIndex, setEditingTextOverlayIndex] = useState<number | null>(null);

  // TranscriptCaptionDialog's open state -- no edit-target index needed,
  // there's only ever one transcript caption config (see
  // video_math.ts's TranscriptCaption).
  const [isTranscriptDialogOpen, setIsTranscriptDialogOpen] = useState(false);
  const [isImageTemplatesDialogOpen, setIsImageTemplatesDialogOpen] = useState(false);

  // VideoOverlayFramingDialog's open/edit-target state -- opened from the
  // crosshair button on a VideoOverlayTrack segment, per-overlay index
  // (null means closed, not "add new" -- there's always an existing
  // overlay to fine-tune, unlike the text dialog's add-vs-edit duality).
  const [framingDialogOverlayIndex, setFramingDialogOverlayIndex] = useState<number | null>(null);

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

  const selections: EditSelectionsSnapshot = {
    clipRectId: rawSelections.clipRectId ?? null,
    cropRect: rawSelections.cropRect ?? null,
    zoomEffects: rawSelections.zoomEffects ?? [],
    flipHorizontalToggles: rawSelections.flipHorizontalToggles ?? [],
    flipVerticalToggles: rawSelections.flipVerticalToggles ?? [],
    trimRanges: rawSelections.trimRanges ?? [],
    overlayImages: rawSelections.overlayImages ?? [],
    textOverlays: rawSelections.textOverlays ?? [],
    sequenceClips,
    videoOverlays: rawSelections.videoOverlays ?? [],
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

  // Unfolds the video sequence into a per-second thumbnail strip + volume
  // graph + duration, one clip at a time. Sequential, not concurrent --
  // decoding a clip's audio fully decodes the whole file into memory with
  // no streaming, so extracting N clips at once means N full decodes
  // resident simultaneously; sequential bounds peak memory at the cost of
  // wall-clock time. Each clip's results append to the accumulating
  // thumbnails/volumeLevels/thumbnailTimestampsSeconds arrays as soon as
  // that one clip finishes, so the strip fills in progressively left to
  // right rather than waiting on the whole sequence. A clip that fails to
  // load (bad URL, decode error) is skipped -- reported once, but doesn't
  // block the rest of the sequence from extracting.
  useEffect(() => {
    if (playbackClips.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setThumbnails([]);
      setThumbnailTimestampsSeconds([]);
      setClipBoundarySeconds([]);
      setVolumeLevels([]);
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
    setVolumeLevels([]);
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
      let accumulatedVolumeLevels: number[] = [];

      for (const clip of playbackClips) {
        if (cancelled) return;
        if (cursor > 0) boundaries.push(cursor);
        const clipStartSeconds = cursor;

        if (clip.kind === "image") {
          // An image clip has no file to probe/decode -- its duration is
          // authored (see lib/video/imageTemplates.ts), its "thumbnails"
          // are just its own URL held for every sampled tick (same
          // shortcut AssetGallery.tsx already uses for image tiles), and
          // it has no audio, so its volume buckets are silent.
          const clipDurationSeconds = clip.durationSeconds;
          const clipTimestamps = generateSampleTimestamps(clipDurationSeconds, THUMBNAIL_INTERVAL_SECONDS).map(
            (t) => t + clipStartSeconds
          );
          accumulatedThumbnails = [...accumulatedThumbnails, ...clipTimestamps.map(() => clip.url)];
          accumulatedTimestamps = [...accumulatedTimestamps, ...clipTimestamps];
          setThumbnails(accumulatedThumbnails);
          setThumbnailTimestampsSeconds(accumulatedTimestamps);

          const volumeBucketCount = generateSampleTimestamps(clipDurationSeconds, VOLUME_BUCKET_SECONDS).length;
          accumulatedVolumeLevels = [...accumulatedVolumeLevels, ...new Array(volumeBucketCount).fill(0)];
          setVolumeLevels(accumulatedVolumeLevels);

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

        const [thumbnailsResult, volumeResult] = await Promise.allSettled([
          extractThumbnails(clip.url, THUMBNAIL_INTERVAL_SECONDS),
          extractVolumeProfile(clip.url, VOLUME_BUCKET_SECONDS),
        ]);
        if (cancelled) return;

        if (thumbnailsResult.status === "fulfilled") {
          accumulatedThumbnails = [...accumulatedThumbnails, ...thumbnailsResult.value];
          const clipTimestamps = generateSampleTimestamps(clipDurationSeconds, THUMBNAIL_INTERVAL_SECONDS).map(
            (t) => t + clipStartSeconds
          );
          accumulatedTimestamps = [...accumulatedTimestamps, ...clipTimestamps];
          setThumbnails(accumulatedThumbnails);
          setThumbnailTimestampsSeconds(accumulatedTimestamps);
        } else {
          reportFailure(thumbnailsResult.reason);
        }

        if (volumeResult.status === "fulfilled") {
          accumulatedVolumeLevels = [...accumulatedVolumeLevels, ...volumeResult.value];
          setVolumeLevels(accumulatedVolumeLevels);
        } else {
          reportFailure(volumeResult.reason);
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

    const referencesDeletedAsset =
      selections.overlayImages.some((overlay) => overlay.assetId === assetId) ||
      selections.sequenceClips.some((entry) => entry.assetId === assetId) ||
      selections.videoOverlays.some((overlay) => overlay.assetId === assetId);
    if (referencesDeletedAsset) {
      const { label, state } = {
        label: "Removed deleted asset",
        state: {
          ...selections,
          overlayImages: selections.overlayImages.filter((overlay) => overlay.assetId !== assetId),
          sequenceClips: selections.sequenceClips.filter((entry) => entry.assetId !== assetId),
          videoOverlays: selections.videoOverlays.filter((overlay) => overlay.assetId !== assetId),
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

  // Right-click "Add" on an image asset in AssetGallery -- places it as an
  // overlay starting at the first frame (time 0), per spec.
  function handleAddOverlay(asset: Asset) {
    const { label, state } = applyAddOverlayImage(selections, asset.id, videoDurationSeconds);
    pushChange(label, state);
  }

  // Right-click "Add" on a video asset in AssetGallery -- appends it to
  // the concatenated sequence. The first Add is what starts rendering
  // frames at all; every later one plays right after whatever's already
  // there.
  function handleAddToSequence(asset: Asset) {
    const { label, state } = applyAddSequenceClip(selections, asset.id);
    pushChange(label, state);
  }

  // Right-click "Overlay" on a video asset in AssetGallery -- places it on
  // its own rail at the current playhead, defaulting to a Full-Screen
  // layout the user can switch afterward (see VideoOverlayTrack.tsx). Needs
  // the source asset's own probed duration to size/clamp the default window
  // against -- reuses the cache built by the probing effect above, or
  // probes it fresh (and caches it) if this is the first time this asset's
  // been used this way.
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
  // live-edit/commit split as handleChangeOverlayRect/handleCommitOverlayRect
  // below, for the pre-existing image-overlay feature.
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
    if (framingDialogOverlayIndex === overlayIndex) setFramingDialogOverlayIndex(null);
    const { label, state } = applyDeleteVideoOverlay(selections, overlayIndex);
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

  // VideoOverlayFramingDialog's "Save" -- one commit, no live/commit split
  // (see applyChangeOverlayFraming's own comment).
  function handleSaveVideoOverlayFraming(framing: OverlayFraming) {
    if (framingDialogOverlayIndex === null) return;
    const { label, state } = applyChangeOverlayFraming(selections, framingDialogOverlayIndex, framing);
    pushChange(label, state);
    setFramingDialogOverlayIndex(null);
  }

  // "Image" button in UserActions -- opens ImageTemplatesDialog fresh.
  function handleOpenImageTemplatesDialog() {
    setIsImageTemplatesDialogOpen(true);
  }

  function handleCloseImageTemplatesDialog() {
    setIsImageTemplatesDialogOpen(false);
  }

  // ImageTemplatesDialog's "Add to video" -- appends a new image clip,
  // animated via the chosen Ken Burns template, to the end of the
  // sequence. The clip and its auto-generated ZoomEffect land in ONE
  // history entry (applyAddImageSequenceClip), so undo removes both
  // together. `videoDurationSeconds` (already tracked from the extraction
  // effect above) is the sequence's current total length, i.e. exactly
  // where this new clip starts.
  function handleAddImageSequenceClip(assetId: string, durationSeconds: number, templateId: string) {
    const { label, state } = applyAddImageSequenceClip(selections, assetId, durationSeconds, templateId, videoDurationSeconds);
    pushChange(label, state);
    setIsImageTemplatesDialogOpen(false);
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

  function handleChangeOverlayRect(overlayIndex: number, next: CropRect) {
    setLiveOverlayRectEdit({ index: overlayIndex, rect: next });
  }

  function handleCommitOverlayRect(overlayIndex: number, next: CropRect) {
    setLiveOverlayRectEdit(null);
    const { label, state } = applyOverlayRectCommit(selections, overlayIndex, next);
    pushChange(label, state);
  }

  function handleChangeOverlayRange(overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) {
    setLiveOverlayRangeEdit({ index: overlayIndex, startTimeSeconds, endTimeSeconds });
  }

  function handleCommitOverlayRange(overlayIndex: number, startTimeSeconds: number, endTimeSeconds: number) {
    setLiveOverlayRangeEdit(null);
    const { label, state } = applyOverlayRangeChange(selections, overlayIndex, startTimeSeconds, endTimeSeconds);
    pushChange(label, state);
  }

  function handleDeleteOverlay(overlayIndex: number) {
    setLiveOverlayRectEdit((prev) => (prev?.index === overlayIndex ? null : prev));
    setLiveOverlayRangeEdit((prev) => (prev?.index === overlayIndex ? null : prev));
    const { label, state } = applyDeleteOverlayImage(selections, overlayIndex);
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

  // Splices any in-progress rect/range drag into the persisted array at
  // its own index, same pattern as displayedZoomEffects above.
  const displayedOverlayImages: OverlayImage[] = selections.overlayImages.map((overlay, index) => {
    if (liveOverlayRectEdit?.index === index) return { ...overlay, rect: liveOverlayRectEdit.rect };
    if (liveOverlayRangeEdit?.index === index) {
      return {
        ...overlay,
        startTimeSeconds: liveOverlayRangeEdit.startTimeSeconds,
        endTimeSeconds: liveOverlayRangeEdit.endTimeSeconds,
      };
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
    const freshAssets = await refreshAssets();
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
      outputWidth: width,
      outputHeight: height,
    });
  }

  const framingDialogOverlay = framingDialogOverlayIndex !== null ? displayedVideoOverlays[framingDialogOverlayIndex] ?? null : null;

  return (
    <div className="flex h-full flex-col">
      <section style={{ flexBasis: "30%" }} className="shrink-0 overflow-hidden border-b border-border">
        <ActionArea
          projectId={projectId}
          assets={assets}
          assetsLoaded={assetsLoaded}
          selectedAsset={selectedAsset}
          onSelectAsset={setSelectedAsset}
          onUploaded={handleUploaded}
          onUploadingChange={setIsUploading}
          onAssetDeleted={handleAssetDeleted}
          onAddOverlay={handleAddOverlay}
          onAddToSequence={handleAddToSequence}
          onAddVideoOverlay={handleAddVideoOverlay}
          onAddToBackgroundSequence={handleAddToBackgroundSequence}
          usedAssetIds={usedAssetIds}
          videoThumbnailUrlByAssetId={videoThumbnailUrlByAssetId}
          framingDialogOverlay={framingDialogOverlay}
          onSaveVideoOverlayFraming={handleSaveVideoOverlayFraming}
          onCloseVideoOverlayFramingDialog={handleCloseVideoOverlayFramingDialog}
          selectedClipRectId={selections.clipRectId}
          onSelectClipRect={handleSelectClipRect}
          onOpenTextDialog={handleOpenTextDialog}
          isTextDialogOpen={isTextDialogOpen}
          editingTextOverlay={editingTextOverlayIndex !== null ? displayedTextOverlays[editingTextOverlayIndex] : null}
          onSaveTextOverlay={handleSaveTextOverlay}
          onCloseTextDialog={handleCloseTextDialog}
          onOpenTranscriptDialog={handleOpenTranscriptDialog}
          isTranscriptDialogOpen={isTranscriptDialogOpen}
          transcriptCaption={selections.transcriptCaption}
          onSaveTranscriptCaption={handleSaveTranscriptCaption}
          onDisableTranscriptCaption={handleDisableTranscriptCaption}
          onCloseTranscriptDialog={handleCloseTranscriptDialog}
          onOpenImageTemplatesDialog={handleOpenImageTemplatesDialog}
          isImageTemplatesDialogOpen={isImageTemplatesDialogOpen}
          onAddImageSequenceClip={handleAddImageSequenceClip}
          onCloseImageTemplatesDialog={handleCloseImageTemplatesDialog}
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
          sequenceClips={playbackClips}
          videoOverlays={displayedVideoOverlays}
          backgroundTracks={resolvedBackgroundTracks}
          assetUrlById={assetUrlById}
          onFrameDimensions={setFrameDimensions}
          playerRef={canvasPlayerRef}
          onPlayerTimeUpdate={setCurrentTimeSeconds}
        />
      </section>

      <section style={{ flexBasis: "50%" }} className="shrink-0 overflow-hidden border-b border-border">
        <Playground
          backgroundTracks={resolvedBackgroundTracks}
          videoDurationSeconds={videoDurationSeconds}
          thumbnails={thumbnails}
          thumbnailTimestampsSeconds={thumbnailTimestampsSeconds}
          clipBoundarySeconds={clipBoundarySeconds}
          sequenceEntries={effectiveSequenceEntries}
          onResizeImageClip={handleResizeImageClip}
          volumeLevels={volumeLevels}
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
          onChangeOverlayRect={handleChangeOverlayRect}
          onCommitOverlayRect={handleCommitOverlayRect}
          onChangeOverlayRange={handleChangeOverlayRange}
          onCommitOverlayRange={handleCommitOverlayRange}
          onDeleteOverlay={handleDeleteOverlay}
          textOverlays={displayedTextOverlays}
          onChangeTextOverlayRect={handleChangeTextOverlayRect}
          onCommitTextOverlayRect={handleCommitTextOverlayRect}
          onChangeTextOverlayRange={handleChangeTextOverlayRange}
          onCommitTextOverlayRange={handleCommitTextOverlayRange}
          onDeleteTextOverlay={handleDeleteTextOverlay}
          onRequestEditTextOverlay={handleRequestEditTextOverlay}
          videoOverlays={displayedVideoOverlays}
          videoThumbnailUrlByAssetId={videoThumbnailUrlByAssetId}
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
          onDeleteVideoOverlay={handleDeleteVideoOverlay}
        />
      </section>

      <section style={{ flexBasis: "20%" }} className="shrink-0 overflow-y-auto">
        <FeedbackArea
          assetsError={assetsError}
          analysisError={analysisError}
          saveError={saveError}
          isAnalyzing={isAnalyzing}
          isUploading={isUploading}
          selections={{
            ...selections,
            zoomEffects: displayedZoomEffects,
            overlayImages: displayedOverlayImages,
            textOverlays: displayedTextOverlays,
            videoOverlays: displayedVideoOverlays,
          }}
          videoDurationSeconds={videoDurationSeconds}
          canRender={effectiveSequenceEntries.length > 0}
          isRendering={isRendering}
          renderStatus={renderStatus}
          renderUrl={renderUrl}
          renderError={renderError}
          isRenderStuck={isRenderStuck}
          onRenderClick={handleRenderClick}
          canLocalRender={effectiveSequenceEntries.length > 0}
          isLocalRendering={isLocalRendering}
          isLocalRenderSupported={isLocalRenderSupported}
          localRenderUnsupportedReason={localRenderUnsupportedReason}
          onLocalRenderClick={handleLocalRenderClick}
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
  );
}
