"use client";

/**
 * Top-level layout for the client-side video editor (baby-steps rebuild of
 * the reel editor) -- rendered directly by /dashboard/[projectId]. The old
 * Creatomate-based VideoEditor.tsx is kept in the codebase but unreferenced,
 * for a possible future re-hook rather than a full rebuild of render/trim/
 * background/overlay.
 *
 * Three fixed horizontal bands per spec: 30% action area, 50% playground,
 * 20% feedback area. This component owns the cross-band state (the full
 * asset list, which one is selected, the frame-affecting edit history,
 * playback position, the crop rect + zoom effect) and the thumbnail/volume
 * extraction pipeline; each band below is otherwise a plain,
 * mostly-stateless view.
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
import {
  computeEffectiveCropRect,
  computeMaxCoverageCropFraction,
  scaleCropRectCentered,
  FULL_FRAME_CROP_RECT,
  type CropRect,
} from "@/lib/video/video_math";
import { saveTimeline, type Timeline, type EditSelectionsSnapshot } from "@/lib/projects";
import { useEditHistory } from "@/lib/useEditHistory";
import { CLIP_RECT_OPTIONS } from "./ClipRectIcon";
import { ActionArea } from "./ActionArea";
import { Playground } from "./Playground";
import { FeedbackArea } from "./FeedbackArea";
import type { CanvasPlayerHandle } from "./CanvasPlayer";

const THUMBNAIL_INTERVAL_SECONDS = 1;
const VOLUME_BUCKET_SECONDS = 1;
const SAVE_DEBOUNCE_MS = 600;
const DEFAULT_ZOOM_SCALE = 0.65;
const DEFAULT_ZOOM_DURATION_SECONDS = 2;

const DEFAULT_SELECTIONS: EditSelectionsSnapshot = { clipRectId: null, cropRect: null, zoomEffect: null };

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

  // Live position of the crop rect while actively dragging, before it's
  // committed to history -- kept separate from `selections.cropRect` so a
  // drag-in-progress doesn't spam the change list (see handleCropRectCommit).
  const [liveCropRect, setLiveCropRect] = useState<CropRect | null>(null);

  const canvasPlayerRef = useRef<CanvasPlayerHandle>(null);

  // Cosmetic-only, persisted but not history-tracked (see this file's
  // module comment).
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    initialTimeline.selectedTemplateId ?? null
  );
  const [selectedBackgroundTrackId, setSelectedBackgroundTrackId] = useState(
    initialTimeline.selectedBackgroundTrackId ?? "none"
  );

  // Frame-affecting, history-tracked -- every change is a revertible entry
  // in FeedbackArea's change list, persisted into Timeline.editHistory so
  // reopening this reel resumes with the same history intact.
  const {
    state: selections,
    entries: editHistoryEntries,
    currentIndex: editHistoryIndex,
    pushChange,
    revertTo,
    undo,
    redo,
  } = useEditHistory<EditSelectionsSnapshot>(DEFAULT_SELECTIONS, initialTimeline.editHistory, initialTimeline.editHistoryIndex);

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

  // Whether a zoom effect is actively interpolating the crop rect right
  // now -- if so, the overlay shown is a computed, temporary value, not
  // something a drag should be allowed to fight with (see
  // CanvasPlayer/ActionArea's comments on why onCropRectChange/Commit get
  // omitted rather than passed as no-ops in that case).
  const isZoomActiveNow = Boolean(
    selections.zoomEffect &&
      currentTimeSeconds > selections.zoomEffect.startTimeSeconds &&
      currentTimeSeconds < selections.zoomEffect.endTimeSeconds
  );

  const displayedCropRect = liveCropRect
    ? liveCropRect
    : selections.cropRect
      ? computeEffectiveCropRect(selections.cropRect, selections.zoomEffect, currentTimeSeconds)
      : null;

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
  }, [projectId, initialTimeline, editHistoryEntries, editHistoryIndex, selectedTemplateId, selectedBackgroundTrackId]);

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
    const cropRect = computeMaxCoverageCropFraction(sourceAspectRatio, targetRatio);
    pushChange(`Clip rectangle: ${id}`, { ...selections, clipRectId: id, cropRect, zoomEffect: null });
  }

  function handleCropRectChange(next: CropRect) {
    setLiveCropRect(next);
  }

  function handleCropRectCommit(next: CropRect) {
    setLiveCropRect(null);
    pushChange("Adjusted crop", { ...selections, cropRect: next });
  }

  function createZoomEffect(direction: "in" | "out") {
    const baseCropRect = selections.cropRect ?? FULL_FRAME_CROP_RECT;
    const scaledRect = scaleCropRectCentered(baseCropRect, DEFAULT_ZOOM_SCALE);
    const startTimeSeconds = currentTimeSeconds;
    const endTimeSeconds = Math.min(
      currentTimeSeconds + DEFAULT_ZOOM_DURATION_SECONDS,
      videoDurationSeconds > 0 ? videoDurationSeconds : currentTimeSeconds + DEFAULT_ZOOM_DURATION_SECONDS
    );
    const zoomEffect = {
      startTimeSeconds,
      endTimeSeconds,
      startRect: direction === "in" ? baseCropRect : scaledRect,
      endRect: direction === "in" ? scaledRect : baseCropRect,
    };
    pushChange(direction === "in" ? "Zoom in" : "Zoom out", { ...selections, zoomEffect });
  }

  // Live position of the zoom effect's time range while actively dragging
  // one of its edges, before it's committed to history -- same "change vs.
  // commit" split as liveCropRect above, so a drag doesn't spam the change
  // list with an entry per pixel of movement.
  const [liveZoomEffect, setLiveZoomEffect] = useState<EditSelectionsSnapshot["zoomEffect"]>(null);

  function handleChangeZoomRange(startTimeSeconds: number, endTimeSeconds: number) {
    if (!selections.zoomEffect) return;
    setLiveZoomEffect({ ...selections.zoomEffect, startTimeSeconds, endTimeSeconds });
  }

  function handleCommitZoomRange(startTimeSeconds: number, endTimeSeconds: number) {
    if (!selections.zoomEffect) return;
    setLiveZoomEffect(null);
    pushChange("Adjusted zoom range", {
      ...selections,
      zoomEffect: { ...selections.zoomEffect, startTimeSeconds, endTimeSeconds },
    });
  }

  function handleSeek(seconds: number) {
    canvasPlayerRef.current?.seekTo(seconds);
  }

  const displayedZoomEffect = liveZoomEffect ?? selections.zoomEffect;

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
          selectedBackgroundTrackId={selectedBackgroundTrackId}
          onSelectBackgroundTrack={setSelectedBackgroundTrackId}
          selectedTemplateId={selectedTemplateId}
          onSelectTemplate={setSelectedTemplateId}
          selectedClipRectId={selections.clipRectId}
          onSelectClipRect={handleSelectClipRect}
          effectiveCropRect={displayedCropRect}
          onCropRectChange={isZoomActiveNow ? undefined : handleCropRectChange}
          onCropRectCommit={isZoomActiveNow ? undefined : handleCropRectCommit}
          onFrameDimensions={setFrameDimensions}
          onZoomIn={() => createZoomEffect("in")}
          onZoomOut={() => createZoomEffect("out")}
          playerRef={canvasPlayerRef}
          onPlayerTimeUpdate={setCurrentTimeSeconds}
        />
      </section>

      <section style={{ flexBasis: "50%" }} className="shrink-0 overflow-hidden border-b border-border">
        <Playground
          selectedBackgroundTrackId={selectedBackgroundTrackId}
          videoDurationSeconds={videoDurationSeconds}
          thumbnails={thumbnails}
          volumeLevels={volumeLevels}
          isAnalyzing={isAnalyzing}
          currentTimeSeconds={currentTimeSeconds}
          onSeek={handleSeek}
          baseCropRect={selections.cropRect}
          zoomEffect={displayedZoomEffect}
          onChangeZoomRange={handleChangeZoomRange}
          onCommitZoomRange={handleCommitZoomRange}
        />
      </section>

      <section style={{ flexBasis: "20%" }} className="shrink-0 overflow-y-auto">
        <FeedbackArea
          assetsError={assetsError}
          analysisError={analysisError}
          saveError={saveError}
          isAnalyzing={isAnalyzing}
          isUploading={isUploading}
          editHistoryEntries={editHistoryEntries}
          editHistoryIndex={editHistoryIndex}
          onRevertEdit={revertTo}
        />
      </section>
    </div>
  );
}
