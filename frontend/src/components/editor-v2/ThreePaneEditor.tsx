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
 * asset list, which one is selected, the frame-affecting edit history,
 * playback position, the crop rect + zoom effect) and the thumbnail/volume
 * extraction pipeline; each band below is otherwise a plain,
 * mostly-stateless view. It does NOT contain transformation decision logic
 * itself -- see lib/video/transformations.ts for "given the current
 * selections and an action, what's the new state," which this component
 * just calls and pushes through useEditHistory.
 *
 * Template and background-track choices are plain persisted state, not
 * part of the edit history -- they don't change what the frames look like
 * (yet), and the change list (FeedbackArea) is meant to show only actions
 * that do. Clip rectangle (+ its crop rect) and zoom in/out both go
 * through useEditHistory, since both are frame-affecting.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listAssets, type Asset } from "@/lib/api";
import { extractThumbnails, getVideoDuration } from "@/lib/video/video";
import { extractVolumeProfile } from "@/lib/video/audio";
import type { CropRect, OverlayImage, ZoomEffect } from "@/lib/video/video_math";
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
};

export function ThreePaneEditor({ projectId, initialTimeline }: { projectId: string; initialTimeline: Timeline }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsLoaded, setAssetsLoaded] = useState(false);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const [thumbnails, setThumbnails] = useState<string[]>([]);
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
  // one of this project's own assets rather than a curated catalog entry --
  // mutually exclusive, see handleSetBackgroundTrack/handleSelectBackgroundTrack.
  const [selectedBackgroundAssetId, setSelectedBackgroundAssetId] = useState<string | null>(
    initialTimeline.selectedBackgroundAssetId ?? null
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
      // Defaults the play area/timeline to the most recently uploaded video
      // once assets first load -- doesn't override a selection the user (or
      // a just-finished upload) already made.
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

  // Unfolds the selected video into a per-second thumbnail strip + volume
  // graph + duration whenever the selection changes. The extractions run
  // concurrently and update state independently (rather than waiting on
  // Promise.all to fully resolve) so the Playground can render whichever
  // finishes first instead of blocking on the slowest.
  useEffect(() => {
    // Resets the previous asset's extraction results as soon as the
    // selection changes, rather than leaving stale thumbnails/levels on
    // screen while the new asset's extraction is still in flight.
    if (!selectedAsset || selectedAsset.kind !== "video") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setThumbnails([]);
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

    const thumbnailsDone = extractThumbnails(selectedAsset.url, THUMBNAIL_INTERVAL_SECONDS, (framesSoFar) => {
      if (!cancelled) setThumbnails(framesSoFar);
    }).catch(reportFailure);

    const volumeDone = extractVolumeProfile(selectedAsset.url, VOLUME_BUCKET_SECONDS)
      .then((levels) => {
        if (!cancelled) setVolumeLevels(levels);
      })
      .catch(reportFailure);

    // Needed by the background-track strip, to work out how many times a
    // track loops across the video's full length.
    const durationDone = getVideoDuration(selectedAsset.url)
      .then((duration) => {
        if (!cancelled) setVideoDurationSeconds(duration);
      })
      .catch(reportFailure);

    Promise.allSettled([thumbnailsDone, volumeDone, durationDone]).then(() => {
      if (!cancelled) setIsAnalyzing(false);
    });

    return () => {
      cancelled = true;
    };
  }, [selectedAsset]);

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
        selectedBackgroundAssetId,
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
    selectedBackgroundAssetId,
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

  // Right-click "Add" on a music asset in AssetGallery -- sets it as the
  // project's background track, same slot as picking one from
  // BackgroundTrackSelector's curated catalog (the two are mutually
  // exclusive; cosmetic/not history-tracked, like the catalog choice).
  function handleSetBackgroundTrack(asset: Asset) {
    setSelectedBackgroundAssetId(asset.id);
    setSelectedBackgroundTrackId("none");
  }

  function handleSelectBackgroundTrack(id: string) {
    setSelectedBackgroundTrackId(id);
    setSelectedBackgroundAssetId(null);
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

  // assetId -> presigned R2 URL, for CanvasPlayer/FrameStrip/OverlayTrack to
  // resolve an overlay's actual image without each needing their own
  // asset-list lookup.
  const assetUrlById = Object.fromEntries(assets.map((asset) => [asset.id, asset.url]));

  // Every asset currently referenced by at least one overlay, or set as the
  // background track -- drives AssetGallery's "+" in-use badge.
  const usedAssetIds = new Set(selections.overlayImages.map((overlay) => overlay.assetId));
  if (selectedBackgroundAssetId) usedAssetIds.add(selectedBackgroundAssetId);

  // Resolves whichever background source is actually active -- a project
  // asset (selectedBackgroundAssetId) takes precedence, otherwise the
  // curated catalog entry, if any -- into the single shape
  // BackgroundTrackStrip needs. Neither concept is specific to it, so the
  // resolution happens here rather than inside that component.
  const backgroundAsset = selectedBackgroundAssetId
    ? (assets.find((asset) => asset.id === selectedBackgroundAssetId) ?? null)
    : null;
  const backgroundCatalogTrack = BACKGROUND_TRACK_OPTIONS.find((option) => option.id === selectedBackgroundTrackId);
  const resolvedBackgroundTrack = backgroundAsset
    ? { name: backgroundAsset.filename, url: backgroundAsset.url }
    : backgroundCatalogTrack?.url
      ? { name: backgroundCatalogTrack.name, url: backgroundCatalogTrack.url }
      : null;

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
          onSetBackgroundTrack={handleSetBackgroundTrack}
          usedAssetIds={usedAssetIds}
          selectedBackgroundTrackId={selectedBackgroundTrackId}
          onSelectBackgroundTrack={handleSelectBackgroundTrack}
          selectedTemplateId={selectedTemplateId}
          onSelectTemplate={setSelectedTemplateId}
          selectedClipRectId={selections.clipRectId}
          onSelectClipRect={handleSelectClipRect}
          baseCropRect={selections.cropRect}
          zoomEffects={displayedZoomEffects}
          liveCropRectOverride={liveCropRect}
          flipHorizontalToggles={selections.flipHorizontalToggles}
          flipVerticalToggles={selections.flipVerticalToggles}
          trimRanges={selections.trimRanges}
          overlayImages={displayedOverlayImages}
          assetUrlById={assetUrlById}
          onFrameDimensions={setFrameDimensions}
          playerRef={canvasPlayerRef}
          onPlayerTimeUpdate={setCurrentTimeSeconds}
        />
      </section>

      <section style={{ flexBasis: "50%" }} className="shrink-0 overflow-hidden border-b border-border">
        <Playground
          backgroundTrack={resolvedBackgroundTrack}
          videoDurationSeconds={videoDurationSeconds}
          thumbnails={thumbnails}
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
        />
      </section>

      <section style={{ flexBasis: "20%" }} className="shrink-0 overflow-y-auto">
        <FeedbackArea
          assetsError={assetsError}
          analysisError={analysisError}
          saveError={saveError}
          isAnalyzing={isAnalyzing}
          isUploading={isUploading}
          selections={{ ...selections, zoomEffects: displayedZoomEffects, overlayImages: displayedOverlayImages }}
          videoDurationSeconds={videoDurationSeconds}
        />
      </section>
    </div>
  );
}
