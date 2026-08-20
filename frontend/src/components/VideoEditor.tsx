"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Preview } from "@creatomate/preview";
import { listAssets, triggerRender, uploadAsset, type Asset } from "@/lib/api";
import { getProject, saveTimeline, type Timeline } from "@/lib/projects";
import { createEmptyReelTimeline, resolveTimelineSources } from "@/lib/timeline/resolve";

const ACCEPTED_FILE_TYPES = "video/mp4,image/jpeg,image/png";
const AUTOSAVE_DEBOUNCE_MS = 800;
const RENDER_POLL_INTERVAL_MS = 5000;
const TERMINAL_RENDER_STATUSES = new Set(["completed", "failed"]);

function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function VideoEditor({ projectId }: { projectId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<Preview | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasLoadedRef = useRef(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isMobile, setIsMobile] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [template, setTemplate] = useState<Timeline>(createEmptyReelTimeline);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [renderStatus, setRenderStatus] = useState<string | null>(null);
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  const videoAssets = assets.filter((asset) => asset.kind === "video");
  const imageAssets = assets.filter((asset) => asset.kind === "image");

  useEffect(() => {
    // navigator is undefined during SSR, so this can't be a lazy useState
    // initializer without risking a hydration mismatch -- it has to run
    // client-side only, after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsMobile(isMobileDevice());
  }, []);

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
        setRenderStatus(project.render_status);
        setRenderUrl(project.render_url);
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

  // Polls render status while a render is in flight -- the webhook + worker
  // pipeline updates projects.render_status/render_url asynchronously, with
  // no push channel back to this tab.
  useEffect(() => {
    if (!renderStatus || TERMINAL_RENDER_STATUSES.has(renderStatus)) return;

    const interval = setInterval(() => {
      getProject(projectId)
        .then((project) => {
          setRenderStatus(project.render_status);
          setRenderUrl(project.render_url);
        })
        .catch(() => {
          // A transient poll failure isn't worth surfacing -- the next tick retries.
        });
    }, RENDER_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [projectId, renderStatus]);

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

  async function pushTemplate(next: Timeline) {
    setTemplate(next);
    if (previewRef.current && isReady) {
      await previewRef.current.setSource(resolveTimelineSources(next, assets));
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // lets the same file be re-selected later
    if (!file) return;

    setIsUploading(true);
    setUploadError(null);
    try {
      const asset = await uploadAsset(projectId, file);
      setAssets((prev) => [asset, ...prev]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);
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
    if (template.elements.some((el) => el.id === "artificial-background")) return;
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

  /** Placeholder: a real implementation would let the user pick which of
   * their uploaded images to overlay. This adds a fixed placeholder overlay
   * in the top-right corner using the first uploaded image, just to
   * demonstrate the state shape. */
  function handleOverlayImage() {
    if (template.elements.some((el) => el.id === "image-overlay")) return;
    const overlayAsset = imageAssets[0];
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
      _appMeta: overlayAsset
        ? { ...template._appMeta, [elementId]: { role: "clip", assetId: overlayAsset.id } }
        : template._appMeta,
    });
  }

  async function handleRender() {
    setIsRendering(true);
    setRenderError(null);
    try {
      const result = await triggerRender(projectId, template);
      setRenderStatus(result.status);
      if (result.warning) setRenderError(result.warning);
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : "Failed to start render");
    } finally {
      setIsRendering(false);
    }
  }

  const buttonClass =
    "rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium " +
    "hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";

  if (isMobile) {
    return (
      <div role="alert" className="m-4 rounded-md border border-amber-300 bg-amber-50 p-4 text-amber-900">
        The video editor requires a desktop browser — the Creatomate Preview
        SDK needs hardware video decoding that mobile browsers don&apos;t
        reliably support. Please switch to a desktop device to continue
        editing.
      </div>
    );
  }

  if (loadError) {
    return <p className="p-4 text-sm text-red-600">Couldn&apos;t load this reel: {loadError}</p>;
  }
  if (!isLoaded) {
    return <p className="p-4 text-sm text-neutral-500">Loading…</p>;
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button className={buttonClass} onClick={handleTrim} disabled={!isReady || !selectedAssetId}>
          Trim
        </button>
        <button className={buttonClass} onClick={handleAddArtificialBackground} disabled={!isReady}>
          Add Artificial Background
        </button>
        <button
          className={buttonClass}
          onClick={handleOverlayImage}
          disabled={!isReady || imageAssets.length === 0}
        >
          Overlay Image
        </button>

        <span className="mx-1 h-5 w-px bg-neutral-300" aria-hidden="true" />

        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          className="hidden"
          onChange={handleFileSelected}
          disabled={isUploading}
        />
        <button
          className={
            "rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 " +
            "disabled:cursor-not-allowed disabled:opacity-40"
          }
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
        >
          {isUploading ? "Uploading…" : "Upload video or image"}
        </button>

        <span className="mx-1 h-5 w-px bg-neutral-300" aria-hidden="true" />

        <button
          className={
            "rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-600 " +
            "disabled:cursor-not-allowed disabled:opacity-40"
          }
          onClick={handleRender}
          disabled={isRendering || !selectedAssetId || (!!renderStatus && !TERMINAL_RENDER_STATUSES.has(renderStatus))}
        >
          {isRendering ? "Starting render…" : "Render"}
        </button>
      </div>

      {uploadError && <p className="text-sm text-red-600">{uploadError}</p>}
      {assetsError && <p className="text-sm text-red-600">Couldn&apos;t load assets: {assetsError}</p>}
      {saveError && <p className="text-sm text-red-600">Couldn&apos;t save changes: {saveError}</p>}
      {renderError && <p className="text-sm text-red-600">{renderError}</p>}
      {renderStatus && (
        <p className="text-sm text-neutral-600">
          Render status: <span className="font-medium">{renderStatus}</span>
          {renderStatus === "completed" && renderUrl && (
            <>
              {" — "}
              <a href={renderUrl} target="_blank" rel="noreferrer" className="underline">
                view finished video
              </a>
            </>
          )}
        </p>
      )}

      <div
        ref={containerRef}
        className="w-full max-w-[405px] overflow-hidden rounded-md border border-neutral-300 bg-neutral-900"
        style={{ aspectRatio: "9 / 16" }}
      />

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-neutral-700">Your videos</h2>
        {videoAssets.length === 0 ? (
          <p className="text-sm text-neutral-500">
            No videos yet — click &quot;Upload video or image&quot; above to get started.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {videoAssets.map((asset) => (
              <li key={asset.id}>
                <button
                  className={
                    "w-full rounded-md border px-3 py-1.5 text-left text-sm hover:bg-neutral-100 " +
                    (asset.id === selectedAssetId
                      ? "border-neutral-900 font-medium"
                      : "border-neutral-300")
                  }
                  onClick={() => handleSelectAsset(asset)}
                >
                  {asset.filename}
                  {asset.id === selectedAssetId ? " (selected)" : ""}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
