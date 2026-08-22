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
 * asset list, which one is selected, the edit-selections history, playback
 * position) and the thumbnail/volume extraction pipeline; each band below
 * is otherwise a plain, mostly-stateless view.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listAssets, type Asset } from "@/lib/api";
import { extractThumbnails, getVideoDuration } from "@/lib/video/video";
import { extractVolumeProfile } from "@/lib/video/audio";
import { saveTimeline, type Timeline, type EditSelectionsSnapshot } from "@/lib/projects";
import { useEditHistory } from "@/lib/useEditHistory";
import { TEMPLATE_OPTIONS } from "@/lib/templates";
import { BACKGROUND_TRACK_OPTIONS } from "@/lib/backgroundTracks";
import { ActionArea } from "./ActionArea";
import { Playground } from "./Playground";
import { FeedbackArea } from "./FeedbackArea";
import type { CanvasPlayerHandle } from "./CanvasPlayer";

const THUMBNAIL_INTERVAL_SECONDS = 1;
const VOLUME_BUCKET_SECONDS = 1;
const SAVE_DEBOUNCE_MS = 600;

const DEFAULT_SELECTIONS: EditSelectionsSnapshot = { templateId: null, clipRectId: null, backgroundTrackId: "none" };

export function ThreePaneEditor({ projectId, initialTimeline }: { projectId: string; initialTimeline: Timeline }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [volumeLevels, setVolumeLevels] = useState<number[]>([]);
  const [videoDurationSeconds, setVideoDurationSeconds] = useState(0);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const canvasPlayerRef = useRef<CanvasPlayerHandle>(null);

  // Selection-only (see UserActions.tsx/BackgroundTrackSelector.tsx), but
  // every change is kept as a revertible entry (FeedbackArea's change list)
  // and persisted into Timeline.editHistory below, so reopening this reel
  // resumes exactly where it was left, not from a blank slate.
  const {
    state: selections,
    entries: editHistoryEntries,
    currentIndex: editHistoryIndex,
    pushChange,
    revertTo,
  } = useEditHistory<EditSelectionsSnapshot>(DEFAULT_SELECTIONS, initialTimeline.editHistory, initialTimeline.editHistoryIndex);

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

  // Persists the edit-selections history into Timeline.editHistory
  // whenever it changes, debounced -- and flushes any pending save
  // immediately on unmount (see the second effect below) rather than
  // silently dropping a change made just before switching reels or
  // navigating away.
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
  }, [projectId, initialTimeline, editHistoryEntries, editHistoryIndex]);

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

  function handleSelectTemplate(id: string) {
    const name = TEMPLATE_OPTIONS.find((option) => option.id === id)?.name ?? id;
    pushChange(`Template: ${name}`, { ...selections, templateId: id });
  }

  function handleSelectClipRect(id: string) {
    pushChange(`Clip rectangle: ${id}`, { ...selections, clipRectId: id });
  }

  function handleSelectBackgroundTrack(id: string) {
    const name = BACKGROUND_TRACK_OPTIONS.find((option) => option.id === id)?.name ?? id;
    pushChange(`Background track: ${name}`, { ...selections, backgroundTrackId: id });
  }

  function handleSeek(seconds: number) {
    canvasPlayerRef.current?.seekTo(seconds);
  }

  return (
    <div className="flex h-full flex-col">
      <section style={{ flexBasis: "30%" }} className="shrink-0 overflow-hidden border-b border-border">
        <ActionArea
          projectId={projectId}
          assets={assets}
          selectedAsset={selectedAsset}
          onSelectAsset={setSelectedAsset}
          onUploaded={handleUploaded}
          onUploadingChange={setIsUploading}
          onAssetDeleted={handleAssetDeleted}
          selectedBackgroundTrackId={selections.backgroundTrackId}
          onSelectBackgroundTrack={handleSelectBackgroundTrack}
          selectedTemplateId={selections.templateId}
          onSelectTemplate={handleSelectTemplate}
          selectedClipRectId={selections.clipRectId}
          onSelectClipRect={handleSelectClipRect}
          playerRef={canvasPlayerRef}
          onPlayerTimeUpdate={setCurrentTimeSeconds}
        />
      </section>

      <section style={{ flexBasis: "50%" }} className="shrink-0 overflow-hidden border-b border-border">
        <Playground
          selectedBackgroundTrackId={selections.backgroundTrackId}
          videoDurationSeconds={videoDurationSeconds}
          thumbnails={thumbnails}
          volumeLevels={volumeLevels}
          isAnalyzing={isAnalyzing}
          currentTimeSeconds={currentTimeSeconds}
          onSeek={handleSeek}
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
