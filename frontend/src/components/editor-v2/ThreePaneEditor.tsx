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
 * The video "selection" is no longer a single asset: `selections.sequenceAssetIds`
 * is an ordered list of video clips concatenated into one continuous
 * timeline (right-click "Add" on a video asset appends to it -- the first
 * Add is what starts rendering frames at all, every later one plays right
 * after whatever's already there). Everything else -- crop, zoom/pan,
 * flip, trim, overlays -- is defined purely in terms of "elapsed seconds
 * across the sequence" and has no idea a video is more than one physical
 * file; only this component's own extraction pipeline and CanvasPlayer
 * needed real changes to support that.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listAssets, type Asset } from "@/lib/api";
import { extractThumbnails, getVideoDuration } from "@/lib/video/video";
import { extractVolumeProfile } from "@/lib/video/audio";
import {
  generateSampleTimestamps,
  findClosestTimestampIndex,
  type CropRect,
  type OverlayImage,
  type TextOverlay,
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
  applyAddTextOverlay,
  applyEditTextOverlay,
  applyTextOverlayRectCommit,
  applyTextOverlayRangeChange,
  applyDeleteTextOverlay,
} from "@/lib/video/transformations";
import { saveTimeline, type Timeline, type EditSelectionsSnapshot } from "@/lib/projects";
import { useEditHistory } from "@/lib/useEditHistory";
import { CLIP_RECT_OPTIONS } from "./ClipRectIcon";
import { BACKGROUND_TRACK_OPTIONS } from "@/lib/backgroundTracks";
import { ActionArea } from "./ActionArea";
import { Playground } from "./Playground";
import { FeedbackArea } from "./FeedbackArea";
import type { CanvasPlayerHandle } from "./CanvasPlayer";

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
  sequenceAssetIds: [],
};

export function ThreePaneEditor({ projectId, initialTimeline }: { projectId: string; initialTimeline: Timeline }) {
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

  // TextOverlayDialog's open/edit-target state -- null editingTextOverlayIndex
  // means "Add" (a fresh overlay); otherwise it's pre-filled for editing
  // that existing overlay's text/template.
  const [isTextDialogOpen, setIsTextDialogOpen] = useState(false);
  const [editingTextOverlayIndex, setEditingTextOverlayIndex] = useState<number | null>(null);

  const canvasPlayerRef = useRef<CanvasPlayerHandle>(null);

  // Cosmetic-only, persisted but not history-tracked (see this file's
  // module comment).
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    initialTimeline.selectedTemplateId ?? null
  );
  const [selectedBackgroundTrackId, setSelectedBackgroundTrackId] = useState(
    initialTimeline.selectedBackgroundTrackId ?? "none"
  );
  // Set instead of selectedBackgroundTrackId when the background music is
  // one or more of this project's own assets -- ordered, appended to by
  // AssetGallery's right-click "Add" on a music tile (multiple tracks
  // concatenate, see BackgroundTrackStrip) -- mutually exclusive with the
  // catalog choice, see handleAddToBackgroundSequence/handleSelectBackgroundTrack.
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
  const selections: EditSelectionsSnapshot = {
    clipRectId: rawSelections.clipRectId ?? null,
    cropRect: rawSelections.cropRect ?? null,
    zoomEffects: rawSelections.zoomEffects ?? [],
    flipHorizontalToggles: rawSelections.flipHorizontalToggles ?? [],
    flipVerticalToggles: rawSelections.flipVerticalToggles ?? [],
    trimRanges: rawSelections.trimRanges ?? [],
    overlayImages: rawSelections.overlayImages ?? [],
    textOverlays: rawSelections.textOverlays ?? [],
    sequenceAssetIds: rawSelections.sequenceAssetIds ?? [],
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

  const refreshAssets = useCallback(async () => {
    try {
      const data = await listAssets(projectId);
      setAssets(data);
      setAssetsError(null);
      // Defaults the gallery's highlighted asset to the most recently
      // uploaded video once assets first load -- doesn't override a
      // selection the user (or a just-finished upload) already made. Only
      // cosmetic now: the sequence (below), not this, drives what plays.
      setSelectedAsset((prev) => prev ?? data.find((asset) => asset.kind === "video") ?? null);
    } catch (err) {
      setAssetsError(err instanceof Error ? err.message : "Failed to load assets");
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

  // The sequence to actually play: persisted sequenceAssetIds, filtered to
  // ids that still resolve to a real asset (so a deleted asset silently
  // drops out of playback instead of breaking it). If that's empty and a
  // video asset exists, falls back to that one video as a NON-PERSISTED
  // runtime default (mirrors the old auto-select-most-recent-video
  // behavior for existing/first-time projects, without writing a
  // synthetic history entry).
  const sequenceAssetIdsInAssets = selections.sequenceAssetIds.filter((id) => assetUrlById[id]);
  const fallbackVideoAsset = assets.find((asset) => asset.kind === "video") ?? null;
  const effectiveSequenceAssetIds =
    sequenceAssetIdsInAssets.length > 0 ? sequenceAssetIdsInAssets : fallbackVideoAsset ? [fallbackVideoAsset.id] : [];
  const sequenceClips = effectiveSequenceAssetIds.map((assetId) => ({ assetId, url: assetUrlById[assetId] }));
  const sequenceClipsKey = sequenceClips.map((clip) => clip.assetId).join(",");

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
    if (sequenceClips.length === 0) {
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

      for (const clip of sequenceClips) {
        if (cancelled) return;
        if (cursor > 0) boundaries.push(cursor);

        let clipDurationSeconds: number;
        try {
          clipDurationSeconds = await getVideoDuration(clip.url);
        } catch (err) {
          reportFailure(err);
          continue;
        }
        if (cancelled) return;

        const clipStartSeconds = cursor;
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
      selections.sequenceAssetIds.includes(assetId);
    if (referencesDeletedAsset) {
      const { label, state } = {
        label: "Removed deleted asset",
        state: {
          ...selections,
          overlayImages: selections.overlayImages.filter((overlay) => overlay.assetId !== assetId),
          sequenceAssetIds: selections.sequenceAssetIds.filter((id) => id !== assetId),
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

  // Right-click "Add" on a music asset in AssetGallery -- appends it to
  // the background-music sequence (multiple appended tracks concatenate,
  // then the whole thing loops across the video's duration -- see
  // BackgroundTrackStrip). Mutually exclusive with the curated catalog
  // choice; cosmetic/not history-tracked, like the catalog choice.
  function handleAddToBackgroundSequence(asset: Asset) {
    setBackgroundSequenceAssetIds((prev) => [...prev, asset.id]);
    setSelectedBackgroundTrackId("none");
  }

  function handleSelectBackgroundTrack(id: string) {
    setSelectedBackgroundTrackId(id);
    setBackgroundSequenceAssetIds([]);
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

  // Every asset currently referenced by at least one overlay, in the video
  // sequence, or in the background-music sequence -- drives AssetGallery's
  // "+" in-use badge.
  const usedAssetIds = new Set([
    ...selections.overlayImages.map((overlay) => overlay.assetId),
    ...selections.sequenceAssetIds,
    ...backgroundSequenceAssetIds,
  ]);

  // Resolves the background-music sequence into the ordered {name, url}
  // list BackgroundTrackStrip needs to visualize (concatenated, then
  // looped across the video's duration) -- a project asset sequence takes
  // precedence over the curated catalog entry, if any.
  const backgroundAssetTracks = backgroundSequenceAssetIds
    .map((id) => assets.find((asset) => asset.id === id))
    .filter((asset): asset is Asset => Boolean(asset))
    .map((asset) => ({ name: asset.filename, url: asset.url }));
  const backgroundCatalogTrack = BACKGROUND_TRACK_OPTIONS.find((option) => option.id === selectedBackgroundTrackId);
  const resolvedBackgroundTracks =
    backgroundAssetTracks.length > 0
      ? backgroundAssetTracks
      : backgroundCatalogTrack?.url
        ? [{ name: backgroundCatalogTrack.name, url: backgroundCatalogTrack.url }]
        : [];

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
          onAddToBackgroundSequence={handleAddToBackgroundSequence}
          usedAssetIds={usedAssetIds}
          selectedBackgroundTrackId={selectedBackgroundTrackId}
          onSelectBackgroundTrack={handleSelectBackgroundTrack}
          selectedTemplateId={selectedTemplateId}
          onSelectTemplate={setSelectedTemplateId}
          selectedClipRectId={selections.clipRectId}
          onSelectClipRect={handleSelectClipRect}
          onOpenTextDialog={handleOpenTextDialog}
          isTextDialogOpen={isTextDialogOpen}
          editingTextOverlay={editingTextOverlayIndex !== null ? displayedTextOverlays[editingTextOverlayIndex] : null}
          onSaveTextOverlay={handleSaveTextOverlay}
          onCloseTextDialog={handleCloseTextDialog}
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
          sequenceClips={sequenceClips}
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
          }}
          videoDurationSeconds={videoDurationSeconds}
        />
      </section>
    </div>
  );
}
