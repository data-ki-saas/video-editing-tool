"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Preview } from "@creatomate/preview";
import { listAssets, type Asset } from "@/lib/api";
import { getProject, saveTimeline, type Timeline } from "@/lib/projects";
import { createEmptyReelTimeline, resolveTimelineSources } from "@/lib/timeline/resolve";
import { useRenderStatus } from "@/lib/useRenderStatus";
import { QuickCreate } from "@/components/QuickCreate";
import { useEditorPanel } from "@/lib/editor/EditorPanelContext";
import { AssetsPanel } from "@/components/editor-panels/AssetsPanel";
import { UploadPanel } from "@/components/editor-panels/UploadPanel";
import { TrimPanel } from "@/components/editor-panels/TrimPanel";
import { BackgroundPanel } from "@/components/editor-panels/BackgroundPanel";
import { OverlayPanel } from "@/components/editor-panels/OverlayPanel";
import { RenderPanel } from "@/components/editor-panels/RenderPanel";

const AUTOSAVE_DEBOUNCE_MS = 800;

function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function VideoEditor({ projectId }: { projectId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<Preview | null>(null);
  const hasLoadedRef = useRef(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { activePanel, setActivePanel, setCapabilities } = useEditorPanel();

  const [isMobile, setIsMobile] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [template, setTemplate] = useState<Timeline>(createEmptyReelTimeline);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const { isRendering, renderStatus, renderUrl, renderError, isTerminal, applyProjectStatus, startRender } =
    useRenderStatus(projectId);

  const videoAssets = assets.filter((asset) => asset.kind === "video");
  const imageAssets = assets.filter((asset) => asset.kind === "image");

  const mainVideoElement = template.elements.find((el) => el.id === "main-video");
  const mainVideoTrim =
    mainVideoElement && typeof mainVideoElement.trim_duration === "number"
      ? {
          trim_start: (mainVideoElement.trim_start as number | undefined) ?? 0,
          trim_duration: mainVideoElement.trim_duration as number,
        }
      : null;
  const hasArtificialBackground = template.elements.some((el) => el.id === "artificial-background");
  const hasImageOverlay = template.elements.some((el) => el.id === "image-overlay");

  useEffect(() => {
    // navigator is undefined during SSR, so this can't be a lazy useState
    // initializer without risking a hydration mismatch -- it has to run
    // client-side only, after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsMobile(isMobileDevice());
  }, []);

  // Defaults the sidebar to the "assets" panel for this project. The parent
  // page keys this component by projectId (see [projectId]/page.tsx), so a
  // fresh mount here really does mean "the user switched reels" -- resetting
  // this inside the async load below instead would race a click the user
  // makes on another sidebar action while that fetch is still in flight.
  useEffect(() => {
    setActivePanel("assets");
  }, [setActivePanel]);

  // Loads this reel's persisted timeline once on mount. Guarded by
  // hasLoadedRef so the autosave effect below never fires against the
  // just-created default template before the real one arrives (which would
  // silently overwrite a saved reel with a blank one).
  useEffect(() => {
    let cancelled = false;
    getProject(projectId)
      .then((project) => {
        if (cancelled) return;
        if (project.timeline.elements.length > 0) {
          setTemplate(project.timeline);
          setSelectedAssetId(project.timeline._appMeta["main-video"]?.assetId ?? null);
        }
        applyProjectStatus(project);
        hasLoadedRef.current = true;
        setIsLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load this reel");
      });
    return () => {
      cancelled = true;
    };
    // applyProjectStatus (from useRenderStatus) is stable in behavior for
    // the lifetime of this component -- only projectId should re-trigger
    // this load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

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
    // refreshAssets() itself only calls setState after its await -- this
    // fetch-on-mount/projectId-change pattern is what the effect is for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAssets();
  }, [refreshAssets]);

  // Autosaves the timeline (debounced) whenever it changes, once the initial
  // load has completed. The stored template never contains a resolved asset
  // URL (see lib/timeline/resolve.ts) -- only _appMeta assetId references --
  // so this can save `template` directly with nothing to strip out first.
  useEffect(() => {
    if (!hasLoadedRef.current) return;

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeline(projectId, template)
        .then(() => setSaveError(null))
        .catch((err) => setSaveError(err instanceof Error ? err.message : "Failed to save changes"));
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [projectId, template]);

  // Initializes the Creatomate Preview plugin inside `containerRef` once the
  // device check above has settled -- the SDK needs real desktop-class video
  // decoding, so it's never constructed on a mobile browser (see the
  // early-return render below).
  useEffect(() => {
    if (isMobile || !containerRef.current) return;

    const token = process.env.NEXT_PUBLIC_CREATOMATE_PUBLIC_TOKEN;
    if (!token) {
      console.error("[VideoEditor] NEXT_PUBLIC_CREATOMATE_PUBLIC_TOKEN is not set");
      return;
    }

    const preview = new Preview(containerRef.current, "player", token);
    preview.onReady = () => {
      setIsReady(true);
      void preview.setSource(resolveTimelineSources(template, assets));
    };
    previewRef.current = preview;

    return () => {
      setIsReady(false);
      previewRef.current = null;
      preview.dispose();
    };
    // Only re-initializes when the mobile check settles -- `template`/`assets`
    // are intentionally excluded, they're pushed via setSource() on demand
    // instead of by tearing down and recreating the whole plugin instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMobile]);

  // Publishes which actions the sidebar should show (and whether each is
  // enabled) -- the sidebar lives in the shared dashboard layout, a sibling
  // of this component rather than an ancestor/descendant, so it can't read
  // this state directly.
  const isRenderProcessing = isRendering || (renderStatus !== null && !isTerminal);

  useEffect(() => {
    setCapabilities({
      actions: [
        { key: "assets", label: "Your videos", disabled: false },
        { key: "upload", label: "Upload", disabled: false, busy: isUploading },
        { key: "trim", label: "Trim", disabled: !isReady || !selectedAssetId },
        { key: "background", label: "Add Background", disabled: !isReady },
        { key: "overlay", label: "Overlay Image", disabled: !isReady || imageAssets.length === 0 },
        { key: "render", label: "Render", disabled: isRenderProcessing || !selectedAssetId, busy: isRenderProcessing },
      ],
    });
  }, [isReady, selectedAssetId, imageAssets.length, isUploading, isRenderProcessing, setCapabilities]);

  // Clears the sidebar's action list once this editor is no longer on
  // screen (navigating back to /dashboard or away from it entirely) --
  // deliberately separate from the effect above, which should update the
  // list in place rather than blanking it between every state change.
  useEffect(() => {
    return () => setCapabilities(null);
  }, [setCapabilities]);

  async function pushTemplate(next: Timeline) {
    setTemplate(next);
    if (previewRef.current && isReady) {
      await previewRef.current.setSource(resolveTimelineSources(next, assets));
    }
  }

  function handleSelectAsset(asset: Asset) {
    setSelectedAssetId(asset.id);
    void pushTemplate({
      ...template,
      elements: template.elements.map((el) => (el.id === "main-video" ? { ...el, source: null } : el)),
      _appMeta: { ...template._appMeta, "main-video": { role: "clip", assetId: asset.id } },
    });
  }

  /** Placeholder: a real trim tool would read in/out points from a timeline
   * scrubber. This just sets a fixed 5-second clip starting at 0 on the main
   * video element, to show the JSON shape setSource() expects. Real
   * clip/track editing lands in the next phase. */
  function handleTrim() {
    void pushTemplate({
      ...template,
      elements: template.elements.map((el) =>
        el.id === "main-video" ? { ...el, trim_start: 0, trim_duration: 5 } : el
      ),
    });
  }

  /** Placeholder: a real implementation would call a background removal/
   * generation service and feed its output URL in as the video's matte or a
   * new background element. This just inserts a solid-color shape behind the
   * video on track 0. */
  function handleAddArtificialBackground() {
    if (hasArtificialBackground) return;
    void pushTemplate({
      ...template,
      elements: [
        {
          id: "artificial-background",
          name: "Artificial Background",
          type: "shape",
          track: 0,
          width: "100%",
          height: "100%",
          x: "50%",
          y: "50%",
          fill_color: "#111111",
        },
        ...template.elements,
      ],
    });
  }

  /** Placeholder: a real implementation would support full overlay
   * positioning/sizing. This adds a fixed placeholder overlay in the
   * top-right corner using whichever uploaded image the user picked, just to
   * demonstrate the state shape. */
  function handleOverlayImage(overlayAsset: Asset) {
    if (hasImageOverlay) return;
    const elementId = "image-overlay";
    void pushTemplate({
      ...template,
      elements: [
        ...template.elements,
        {
          id: elementId,
          name: "Image Overlay",
          type: "image",
          track: 2,
          width: "30%",
          height: "30%",
          x: "80%",
          y: "20%",
          source: null,
        },
      ],
      _appMeta: { ...template._appMeta, [elementId]: { role: "clip", assetId: overlayAsset.id } },
    });
  }

  // The Preview SDK needs real desktop-class video decoding, so it's never
  // constructed on a mobile browser -- QuickCreate is the mobile-first
  // counterpart: same upload/persist/render pipeline, no live preview, no
  // manual clip/track editing. See the mobile-quick-create plan.
  if (isMobile) {
    return <QuickCreate projectId={projectId} />;
  }

  if (loadError) {
    return <p className="p-4 text-sm text-red-600">Couldn&apos;t load this reel: {loadError}</p>;
  }
  if (!isLoaded) {
    return <p className="p-4 text-sm text-neutral-500">Loading…</p>;
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {assetsError && <p className="text-sm text-red-600">Couldn&apos;t load assets: {assetsError}</p>}
      {saveError && <p className="text-sm text-red-600">Couldn&apos;t save changes: {saveError}</p>}

      <div
        ref={containerRef}
        className="w-full max-w-[405px] overflow-hidden rounded-md border border-border bg-neutral-900"
        style={{ aspectRatio: "9 / 16" }}
      />

      <div className="max-w-md">
        {activePanel === "assets" && (
          <AssetsPanel videoAssets={videoAssets} selectedAssetId={selectedAssetId} onSelect={handleSelectAsset} />
        )}
        {activePanel === "upload" && (
          <UploadPanel
            projectId={projectId}
            onUploaded={(asset) => setAssets((prev) => [asset, ...prev])}
            onUploadingChange={setIsUploading}
          />
        )}
        {activePanel === "trim" && (
          <TrimPanel disabled={!isReady || !selectedAssetId} trim={mainVideoTrim} onApply={handleTrim} />
        )}
        {activePanel === "background" && (
          <BackgroundPanel
            disabled={!isReady}
            added={hasArtificialBackground}
            onAdd={handleAddArtificialBackground}
          />
        )}
        {activePanel === "overlay" && (
          <OverlayPanel
            disabled={!isReady}
            imageAssets={imageAssets}
            added={hasImageOverlay}
            onAdd={handleOverlayImage}
          />
        )}
        {activePanel === "render" && (
          <RenderPanel
            disabled={isRenderProcessing || !selectedAssetId}
            isRendering={isRendering}
            renderStatus={renderStatus}
            renderUrl={renderUrl}
            renderError={renderError}
            isTerminal={isTerminal}
            onRender={() => startRender(template)}
          />
        )}
      </div>
    </div>
  );
}
