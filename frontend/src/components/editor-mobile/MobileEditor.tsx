"use client";

/**
 * Top-level shell for the touch-first mobile editor -- mounted instead of
 * ThreePaneEditor for a phone/touch viewport (see app/dashboard/[projectId]/
 * page.tsx's useIsMobile branch). ThreePaneEditor itself hard-assumes a
 * mouse and a >=1500px viewport (min-w-[1500px], right-click asset actions)
 * with no responsive fallback, so this is a separate component tree rather
 * than a collapsed layout of that one.
 *
 * Reads/writes the exact same Timeline/EditSelectionsSnapshot shape
 * ThreePaneEditor does (same useEditHistory, same useAutosaveTimeline), so
 * a reel started on phone opens correctly on desktop and vice versa -- this
 * component just doesn't expose UI for the fields it doesn't edit (crop/pan/
 * zoom dragging, video/image overlay framing, freeform text/caption
 * placement, markers, click-to-place trim, per-overlay volume mixing --
 * all confirmed poor touch fits, deliberately left to desktop). Cloud
 * (Creatomate) rendering is disabled app-wide right now (see
 * ThreePaneEditor's own handleRenderClick) -- this editor's Render button
 * shows the identical "coming soon" stub, so it starts working automatically,
 * with no mobile-specific follow-up, once that ships.
 *
 * Unlike ThreePaneEditor, this component does NOT run the full per-second
 * thumbnail-strip extraction pipeline (extractThumbnails) -- that exists to
 * feed FrameStrip's scrubbing timeline, which this editor doesn't have. It
 * only probes what it actually needs: one representative still frame per
 * video asset (captureSingleFrame, same helper ThreePaneEditor already uses
 * for AssetGallery-style thumbnails) and each video clip's real duration
 * (getVideoDuration) so clip reordering/removal can correctly reflow any
 * time-anchored selections a desktop session already authored.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listAssets, type Asset } from "@/lib/api";
import { captureSingleFrame, getVideoDuration } from "@/lib/video/video";
import {
  DEFAULT_MAIN_AUDIO_VOLUME,
  DEFAULT_BACKGROUND_VOLUME,
  DEFAULT_OVERLAY_FRAMING,
  DEFAULT_SPLIT_SCREEN_RATIO,
  type CropRect,
  type ImageOverlayClip,
  type SequenceEntry,
  type TtsOverlay,
  type VideoOverlayClip,
  type VideoOverlayLayout,
} from "@/lib/video/video_math";
import {
  applyAddSequenceClip,
  applyAddImageSequenceClip,
  applyEditImageSequenceClip,
  applyDeleteSequenceClip,
  applyReorderSequenceClip,
  applySelectClipRect,
  applySelectCutawayFilterPreset,
  applySelectClipTransition,
  applyAddTtsOverlay,
  applyEnableTranscriptCaption,
  applyUpdateTranscriptCaption,
  applyDisableTranscriptCaption,
} from "@/lib/video/transformations";
import type { FilterPresetId } from "@/lib/video/filterPresets";
import type { CutTransitionId } from "@/lib/video/cutTransitionPresets";
import { DEFAULT_EDIT_SELECTIONS, type Timeline, type EditSelectionsSnapshot, type Project } from "@/lib/projects";
import { useEditHistory } from "@/lib/useEditHistory";
import { useAutosaveTimeline } from "@/lib/useAutosaveTimeline";
import { CLIP_RECT_OPTIONS } from "@/components/editor-v2/ClipRectIcon";
import { CanvasPlayer, type CanvasPlayerHandle } from "@/components/editor-v2/CanvasPlayer";
import { ClipRectangleDialog } from "@/components/editor-v2/ClipRectangleDialog";
import { FilterPresetDialog } from "@/components/editor-v2/FilterPresetDialog";
import { CutTransitionDialog } from "@/components/editor-v2/CutTransitionDialog";
import { TtsOverlayDialog } from "@/components/editor-v2/TtsOverlayDialog";
import { TranscriptCaptionDialog } from "@/components/editor-v2/TranscriptCaptionDialog";
import { CoverPicker } from "@/components/editor-v2/CoverPicker";
import { RenderComingSoonPopup } from "@/components/editor-v2/RenderComingSoonPopup";
import { MobileAssetStrip } from "./MobileAssetStrip";
import { MobileClipEditor } from "./MobileClipEditor";
import { MobileImageTemplatePicker } from "./MobileImageTemplatePicker";

type ImageSequenceEntry = Extract<SequenceEntry, { kind: "image" }>;

export function MobileEditor({
  projectId,
  initialTimeline,
  initialProject,
}: {
  projectId: string;
  initialTimeline: Timeline;
  initialProject: Project;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [videoThumbnailUrlByAssetId, setVideoThumbnailUrlByAssetId] = useState<Record<string, string>>({});
  const [videoDurationByAssetId, setVideoDurationByAssetId] = useState<Record<string, number>>({});
  const [frameDimensions, setFrameDimensions] = useState<{ width: number; height: number } | null>(null);
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(0);

  const {
    state: rawSelections,
    entries: editHistoryEntries,
    currentIndex: editHistoryIndex,
    pushChange,
  } = useEditHistory<EditSelectionsSnapshot>(DEFAULT_EDIT_SELECTIONS, initialTimeline.editHistory, initialTimeline.editHistoryIndex);

  // Same legacy-shape defenses ThreePaneEditor applies on read (a history
  // entry saved before a field existed is missing it) -- see that file's own
  // comment on why sequenceClips is the one exception that reads an OLD
  // field's meaning (sequenceAssetIds) rather than just defaulting empty.
  const sequenceClips: SequenceEntry[] = useMemo(() => {
    if (rawSelections.sequenceClips) return rawSelections.sequenceClips;
    const legacySequenceAssetIds = (rawSelections as unknown as { sequenceAssetIds?: string[] }).sequenceAssetIds ?? [];
    return legacySequenceAssetIds.map((assetId) => ({ id: crypto.randomUUID(), kind: "video" as const, assetId }));
  }, [rawSelections]);

  // Same framing/baseFraming backfill ThreePaneEditor applies -- CanvasPlayer
  // (mounted below, same component) expects every overlay's `framing` object
  // fully populated and will read undefined fields otherwise. This editor
  // never itself authors an overlay, but must still play back one a desktop
  // session already added without crashing.
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

  // Cosmetic-only Timeline fields this editor doesn't expose UI for --
  // round-tripped unchanged on save, same "kept around, never set here"
  // convention ThreePaneEditor itself uses for selectedTemplateId (dead,
  // no UI anywhere sets it any more) and markers (this editor has no
  // MarkerTrack equivalent).
  const selectedTemplateId = initialTimeline.selectedTemplateId ?? null;
  const markers = initialTimeline.markers ?? [];

  const [selectedBackgroundTrackId, setSelectedBackgroundTrackId] = useState(initialTimeline.selectedBackgroundTrackId ?? "none");
  const [backgroundSequenceAssetIds, setBackgroundSequenceAssetIds] = useState<string[]>(
    initialTimeline.backgroundSequenceAssetIds ??
      (initialTimeline.selectedBackgroundAssetId ? [initialTimeline.selectedBackgroundAssetId] : [])
  );
  const [mainAudioVolume, setMainAudioVolume] = useState(initialTimeline.mainAudioVolume ?? DEFAULT_MAIN_AUDIO_VOLUME);
  const [backgroundVolume, setBackgroundVolume] = useState(initialTimeline.backgroundVolume ?? DEFAULT_BACKGROUND_VOLUME);

  const { saveError } = useAutosaveTimeline({
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
  });

  const refreshAssets = useCallback(async () => {
    try {
      const data = await listAssets(projectId);
      setAssets(data);
      setAssetsError(null);
    } catch (err) {
      setAssetsError(err instanceof Error ? err.message : "Failed to load assets");
    }
  }, [projectId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount, refreshAssets only calls setState after its own await
    void refreshAssets();
  }, [refreshAssets]);

  const assetUrlById = Object.fromEntries(assets.map((asset) => [asset.id, asset.url]));

  // One representative still frame per video asset -- same helper/pattern
  // ThreePaneEditor uses for AssetGallery, NOT the full per-second
  // extractThumbnails strip (see this file's own module comment).
  useEffect(() => {
    let cancelled = false;
    for (const asset of assets) {
      if (asset.kind !== "video" || videoThumbnailUrlByAssetId[asset.id]) continue;
      captureSingleFrame(asset.url)
        .then((frame) => {
          if (!cancelled) setVideoThumbnailUrlByAssetId((prev) => ({ ...prev, [asset.id]: frame }));
        })
        .catch(() => {
          // Leaves this tile on its fallback icon -- not worth surfacing.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [assets, videoThumbnailUrlByAssetId]);

  // Real probed duration for every VIDEO clip currently in the sequence --
  // needed so reordering/removing a clip can correctly reflow any
  // time-anchored selections (zoom effects, overlays, trims) a desktop
  // session may have already authored on this same reel. An image entry
  // never needs this -- its duration is authored (entry.durationSeconds).
  useEffect(() => {
    let cancelled = false;
    for (const entry of sequenceClips) {
      if (entry.kind !== "video") continue;
      if (videoDurationByAssetId[entry.assetId] !== undefined) continue;
      const url = assetUrlById[entry.assetId];
      if (!url) continue;
      getVideoDuration(url)
        .then((duration) => {
          if (!cancelled) setVideoDurationByAssetId((prev) => ({ ...prev, [entry.assetId]: duration }));
        })
        .catch(() => {
          // Leaves this clip's duration unresolved -- reorder/remove involving
          // it just treats it as 0s for the reflow math until this resolves.
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- assetUrlById is a fresh object every render; sequenceClips (from history state) is what actually gates this
  }, [sequenceClips]);

  const getEntryDurationSeconds = useCallback(
    (entry: SequenceEntry): number => (entry.kind === "image" ? entry.durationSeconds : videoDurationByAssetId[entry.assetId] ?? 0),
    [videoDurationByAssetId]
  );
  const getEntryStartSeconds = useCallback(
    (entryId: string): number => {
      let cursor = 0;
      for (const entry of sequenceClips) {
        if (entry.id === entryId) return cursor;
        cursor += getEntryDurationSeconds(entry);
      }
      return cursor;
    },
    [sequenceClips, getEntryDurationSeconds]
  );

  const playbackClips = sequenceClips.filter((entry) => assetUrlById[entry.assetId]).map((entry) => ({ ...entry, url: assetUrlById[entry.assetId] }));

  const backgroundAssetTracks = backgroundSequenceAssetIds
    .map((id) => assets.find((asset) => asset.id === id))
    .filter((asset): asset is Asset => Boolean(asset))
    .map((asset) => ({ name: asset.filename, url: asset.url }));

  const clipRectOption = CLIP_RECT_OPTIONS.find((option) => option.id === selections.clipRectId) ?? null;
  const clipRectAspectRatio = clipRectOption
    ? clipRectOption.widthRatio / clipRectOption.heightRatio
    : frameDimensions
      ? frameDimensions.width / frameDimensions.height
      : 9 / 16; // this app's default reel shape -- see video_math.ts's CLIP_RECT_OPTIONS "9:16" entry
  const frameAspectRatio = frameDimensions ? frameDimensions.width / frameDimensions.height : null;

  // A representative frame for the filter/transition/voiceover/caption
  // dialogs' own live preview -- NOT scrubbing-accurate (this editor has no
  // per-second thumbnail strip, see this file's own module comment), just
  // "some real frame from this clip" so those dialogs have something to
  // preview text/filters against instead of a blank box.
  function previewFrameUrlForEntry(entry: SequenceEntry | undefined): string | null {
    if (!entry) return null;
    const asset = assets.find((a) => a.id === entry.assetId);
    if (!asset) return null;
    return entry.kind === "image" ? asset.url : (videoThumbnailUrlByAssetId[entry.assetId] ?? null);
  }
  const generalPreviewFrameUrl = previewFrameUrlForEntry(sequenceClips[0]);

  const canvasPlayerRef = useRef<CanvasPlayerHandle>(null);

  // Dialog-target state -- one var per dialog, same "at most one non-null at
  // a time, opened from that clip's own menu" convention ThreePaneEditor
  // uses for its own per-clip dialog targets.
  const [clipMenuEntry, setClipMenuEntry] = useState<SequenceEntry | null>(null);
  const [filterDialogEntry, setFilterDialogEntry] = useState<SequenceEntry | null>(null);
  const [transitionDialogEntry, setTransitionDialogEntry] = useState<SequenceEntry | null>(null);
  const [imageMotionTarget, setImageMotionTarget] = useState<
    { mode: "add"; asset: Asset } | { mode: "edit"; entry: ImageSequenceEntry; asset: Asset } | null
  >(null);
  const [isClipRectDialogOpen, setIsClipRectDialogOpen] = useState(false);
  const [isTtsDialogOpen, setIsTtsDialogOpen] = useState(false);
  const [isTranscriptDialogOpen, setIsTranscriptDialogOpen] = useState(false);
  const [isCoverPickerOpen, setIsCoverPickerOpen] = useState(false);
  const [coverThumbnailUrl, setCoverThumbnailUrl] = useState<string | null>(initialProject.thumbnail_url);
  const [isRenderComingSoonOpen, setIsRenderComingSoonOpen] = useState(false);

  function handleUploaded(asset: Asset) {
    setAssets((prev) => [asset, ...prev]);
  }

  function handleAddToSequence(asset: Asset) {
    if (asset.kind === "video") {
      const { label, state } = applyAddSequenceClip(selections, asset.id);
      pushChange(label, state);
    } else if (asset.kind === "image") {
      setImageMotionTarget({ mode: "add", asset });
    }
  }

  function handleAddToBackground(asset: Asset) {
    setBackgroundSequenceAssetIds((prev) => [...prev, asset.id]);
    setSelectedBackgroundTrackId("none");
  }

  function handleRemoveFromBackground(assetId: string) {
    setBackgroundSequenceAssetIds((prev) => prev.filter((id) => id !== assetId));
  }

  function handleRemoveFromSequence(entryId: string) {
    const entry = sequenceClips.find((e) => e.id === entryId);
    if (!entry) return;
    const { label, state } = applyDeleteSequenceClip(selections, entryId, getEntryDurationSeconds(entry), getEntryStartSeconds(entryId));
    pushChange(label, state);
  }

  function handleMoveSequenceEntry(entryId: string, direction: "earlier" | "later") {
    const { label, state } = applyReorderSequenceClip(selections, entryId, direction, getEntryStartSeconds, getEntryDurationSeconds);
    pushChange(label, state);
  }

  function handleSaveImageMotion(durationSeconds: number, templateIds: string[], cropRect: CropRect) {
    if (!imageMotionTarget) return;
    if (imageMotionTarget.mode === "add") {
      const totalDurationSeconds = sequenceClips.reduce((sum, entry) => sum + getEntryDurationSeconds(entry), 0);
      const { label, state } = applyAddImageSequenceClip(
        selections,
        imageMotionTarget.asset.id,
        durationSeconds,
        templateIds,
        cropRect,
        totalDurationSeconds
      );
      pushChange(label, state);
    } else {
      const { label, state } = applyEditImageSequenceClip(
        selections,
        imageMotionTarget.entry.id,
        imageMotionTarget.asset.id,
        durationSeconds,
        templateIds,
        cropRect,
        getEntryStartSeconds(imageMotionTarget.entry.id)
      );
      pushChange(label, state);
    }
    setImageMotionTarget(null);
  }

  function handleSelectFilter(id: FilterPresetId) {
    if (!filterDialogEntry) return;
    const { label, state } = applySelectCutawayFilterPreset(selections, filterDialogEntry.id, id);
    pushChange(label, state);
    setFilterDialogEntry(null);
  }

  function handleSelectTransition(id: CutTransitionId | null) {
    if (!transitionDialogEntry) return;
    const { label, state } = applySelectClipTransition(selections, transitionDialogEntry.id, id);
    pushChange(label, state);
    setTransitionDialogEntry(null);
  }

  function handleSelectClipRectOption(id: string) {
    const option = CLIP_RECT_OPTIONS.find((candidate) => candidate.id === id);
    const targetRatio = option ? option.widthRatio / option.heightRatio : 1;
    const sourceAspectRatio = frameDimensions ? frameDimensions.width / frameDimensions.height : targetRatio;
    const { label, state } = applySelectClipRect(selections, id, targetRatio, sourceAspectRatio);
    pushChange(label, state);
    setIsClipRectDialogOpen(false);
  }

  function handleSaveTtsOverlay(overlay: TtsOverlay) {
    const { label, state } = applyAddTtsOverlay(selections, overlay);
    pushChange(label, state);
    setIsTtsDialogOpen(false);
  }

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

  const transitionIndex = transitionDialogEntry ? sequenceClips.findIndex((entry) => entry.id === transitionDialogEntry.id) : -1;
  const outgoingTransitionEntry = transitionIndex > 0 ? sequenceClips[transitionIndex - 1] : null;

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-background">
      <div className="flex items-center justify-between border-b border-border p-3">
        <h1 className="truncate text-sm font-semibold text-foreground">{initialProject.name}</h1>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => setIsCoverPickerOpen(true)}
            className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground"
          >
            Cover
          </button>
          <button
            type="button"
            onClick={() => setIsRenderComingSoonOpen(true)}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground"
          >
            Render
          </button>
        </div>
      </div>

      {(assetsError || saveError) && (
        <p className="border-b border-border bg-red-600/10 px-3 py-1.5 text-xs text-red-600">{assetsError ?? saveError}</p>
      )}

      <div className="mx-auto w-full max-w-md p-3">
        {playbackClips.length > 0 ? (
          <div className="overflow-hidden rounded-md" style={{ aspectRatio: frameAspectRatio ?? 9 / 16 }}>
            <CanvasPlayer
              ref={canvasPlayerRef}
              clips={playbackClips}
              baseCropRect={selections.cropRect}
              zoomEffects={selections.zoomEffects}
              flipHorizontalToggles={selections.flipHorizontalToggles}
              flipVerticalToggles={selections.flipVerticalToggles}
              trimRanges={selections.trimRanges}
              overlayImages={selections.overlayImages}
              textOverlays={selections.textOverlays}
              ttsOverlays={selections.ttsOverlays}
              videoOverlays={selections.videoOverlays}
              assetUrlById={assetUrlById}
              backgroundTracks={backgroundAssetTracks}
              mainAudioVolume={mainAudioVolume}
              backgroundVolume={backgroundVolume}
              onFrameDimensions={setFrameDimensions}
              onTimeUpdate={setCurrentTimeSeconds}
            />
          </div>
        ) : (
          <div
            className="flex items-center justify-center rounded-md border border-dashed border-border bg-surface p-4 text-center text-xs text-muted"
            style={{ aspectRatio: 9 / 16 }}
          >
            Add a video or photo below to preview your reel
          </div>
        )}
      </div>

      <div className="mx-auto flex w-full max-w-md flex-wrap gap-2 px-3">
        <button
          type="button"
          onClick={() => setIsClipRectDialogOpen(true)}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground"
        >
          Aspect ratio
        </button>
        <button
          type="button"
          onClick={() => setIsTtsDialogOpen(true)}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground"
        >
          Voiceover
        </button>
        <button
          type="button"
          onClick={() => setIsTranscriptDialogOpen(true)}
          className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground"
        >
          {selections.transcriptCaption ? "Captions: on" : "Captions"}
        </button>
      </div>

      {(backgroundSequenceAssetIds.length > 0 || playbackClips.length > 0) && (
        <div className="mx-auto flex w-full max-w-md flex-col gap-2 px-3 pt-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Main volume
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={mainAudioVolume}
              onChange={(e) => setMainAudioVolume(Number(e.target.value))}
            />
          </label>
          {backgroundSequenceAssetIds.length > 0 && (
            <label className="flex flex-col gap-1 text-xs text-muted">
              Background music volume
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={backgroundVolume}
                onChange={(e) => setBackgroundVolume(Number(e.target.value))}
              />
            </label>
          )}
        </div>
      )}

      <div className="mx-auto w-full max-w-md">
        <MobileAssetStrip
          projectId={projectId}
          assets={assets}
          videoThumbnailUrlByAssetId={videoThumbnailUrlByAssetId}
          sequenceClips={sequenceClips}
          backgroundAssetIds={backgroundSequenceAssetIds}
          onUploaded={handleUploaded}
          onAddToSequence={handleAddToSequence}
          onAddToBackground={handleAddToBackground}
          onRemoveFromSequence={handleRemoveFromSequence}
          onMoveSequenceEntry={handleMoveSequenceEntry}
          onRemoveFromBackground={handleRemoveFromBackground}
          onOpenClipMenu={setClipMenuEntry}
        />
      </div>

      {clipMenuEntry && (
        <MobileClipEditor
          isFirstClip={sequenceClips[0]?.id === clipMenuEntry.id}
          isImageClip={clipMenuEntry.kind === "image"}
          onPickMotion={() => {
            const asset = assets.find((a) => a.id === clipMenuEntry.assetId);
            if (asset && clipMenuEntry.kind === "image") setImageMotionTarget({ mode: "edit", entry: clipMenuEntry, asset });
            setClipMenuEntry(null);
          }}
          onPickFilter={() => {
            setFilterDialogEntry(clipMenuEntry);
            setClipMenuEntry(null);
          }}
          onPickTransition={() => {
            setTransitionDialogEntry(clipMenuEntry);
            setClipMenuEntry(null);
          }}
          onRemove={() => {
            handleRemoveFromSequence(clipMenuEntry.id);
            setClipMenuEntry(null);
          }}
          onClose={() => setClipMenuEntry(null)}
        />
      )}

      {imageMotionTarget && (
        <MobileImageTemplatePicker
          asset={imageMotionTarget.asset}
          clipRectAspectRatio={clipRectAspectRatio}
          editing={
            imageMotionTarget.mode === "edit"
              ? { templateIds: imageMotionTarget.entry.templateIds ?? [], durationSeconds: imageMotionTarget.entry.durationSeconds }
              : null
          }
          onSave={handleSaveImageMotion}
          onClose={() => setImageMotionTarget(null)}
        />
      )}

      {filterDialogEntry && (
        <FilterPresetDialog
          selectedFilterId={filterDialogEntry.colorFilterId ?? null}
          onSelect={handleSelectFilter}
          onClose={() => setFilterDialogEntry(null)}
          previewFrameUrl={previewFrameUrlForEntry(filterDialogEntry)}
          frameAspectRatio={frameAspectRatio}
          scopeLabel="this clip"
        />
      )}

      {transitionDialogEntry && (
        <CutTransitionDialog
          selectedTransitionId={transitionDialogEntry.cutTransitionInId ?? null}
          onSelect={handleSelectTransition}
          onClose={() => setTransitionDialogEntry(null)}
          outgoingFrameUrl={previewFrameUrlForEntry(outgoingTransitionEntry ?? undefined)}
          incomingFrameUrl={previewFrameUrlForEntry(transitionDialogEntry)}
          frameAspectRatio={frameAspectRatio}
        />
      )}

      {isClipRectDialogOpen && (
        <ClipRectangleDialog
          selectedClipRectId={selections.clipRectId}
          onSelect={handleSelectClipRectOption}
          onClose={() => setIsClipRectDialogOpen(false)}
          previewFrameUrl={generalPreviewFrameUrl}
          frameAspectRatio={frameAspectRatio}
        />
      )}

      {isTtsDialogOpen && (
        <TtsOverlayDialog
          projectId={projectId}
          editingOverlay={null}
          editingOverlayAssetUrl={null}
          previewFrameUrl={generalPreviewFrameUrl}
          frameAspectRatio={frameAspectRatio}
          currentTimeSeconds={currentTimeSeconds}
          onSave={handleSaveTtsOverlay}
          onClose={() => setIsTtsDialogOpen(false)}
        />
      )}

      {isTranscriptDialogOpen && (
        <TranscriptCaptionDialog
          transcriptCaption={selections.transcriptCaption}
          previewFrameUrl={generalPreviewFrameUrl}
          frameAspectRatio={frameAspectRatio}
          onSave={handleSaveTranscriptCaption}
          onDisable={handleDisableTranscriptCaption}
          onClose={() => setIsTranscriptDialogOpen(false)}
        />
      )}

      {isCoverPickerOpen && (
        <CoverPicker
          projectId={projectId}
          playerRef={canvasPlayerRef}
          currentTimeSeconds={currentTimeSeconds}
          thumbnailUrl={coverThumbnailUrl}
          onSaved={(url) => setCoverThumbnailUrl(url)}
          onCleared={() => setCoverThumbnailUrl(null)}
          onClose={() => setIsCoverPickerOpen(false)}
        />
      )}

      {isRenderComingSoonOpen && <RenderComingSoonPopup onClose={() => setIsRenderComingSoonOpen(false)} />}
    </div>
  );
}
