"use client";

import { useEffect, useRef, useState } from "react";
import { listAssets, uploadAsset, type Asset } from "@/lib/api";
import { getOrCreateNiche } from "@/lib/niches";
import { getProject, saveTimeline, type Project } from "@/lib/projects";
import { autoAssembleTimeline } from "@/lib/timeline/autoAssemble";
import { useRenderStatus } from "@/lib/useRenderStatus";

const ACCEPTED_FILE_TYPES = "video/mp4,image/jpeg,image/png";

function formatNicheLabel(niche: string | null): string | null {
  if (!niche) return null;
  return niche.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Mobile counterpart to VideoEditor.tsx -- rendered instead of the full
 * desktop editor on any mobile browser (see VideoEditor's isMobile branch).
 * No Preview SDK, no manual clip/track editing: upload photos/clips, hit
 * one button, get a rendered reel. lib/timeline/autoAssemble.ts builds the
 * timeline deterministically; the render/persist calls are the exact same
 * ones the desktop editor uses (uploadAsset, saveTimeline, and the shared
 * useRenderStatus hook), so both paths stay on one render pipeline. */
export function QuickCreate({ projectId }: { projectId: string }) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scriptTemplate, setScriptTemplate] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const { isRendering, renderStatus, renderUrl, renderError, isTerminal, applyProjectStatus, startRender } =
    useRenderStatus(projectId);

  useEffect(() => {
    let cancelled = false;
    getProject(projectId)
      .then((data) => {
        if (cancelled) return;
        setProject(data);
        applyProjectStatus(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load this reel");
      });
    return () => {
      cancelled = true;
    };
    // applyProjectStatus is stable for the lifetime of the hook instance --
    // only projectId should re-trigger this load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  useEffect(() => {
    listAssets(projectId)
      .then(setAssets)
      .catch((err) => setAssetsError(err instanceof Error ? err.message : "Failed to load assets"));
  }, [projectId]);

  // The niche was already created (or cache-hit) back in /dashboard/new --
  // this call re-fetches the same niche_key, which is an instant cache hit
  // (no LLM call), just to get script_template for the auto-built caption.
  useEffect(() => {
    if (!project?.niche) return;
    getOrCreateNiche(project.niche)
      .then((niche) => setScriptTemplate(niche.script_template))
      .catch(() => {
        // No script template just means no auto-caption -- not worth
        // blocking quick-create over.
      });
  }, [project?.niche]);

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setIsUploading(true);
    setUploadError(null);
    try {
      const asset = await uploadAsset(projectId, file);
      setAssets((prev) => [...prev, asset]);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  }

  function handleRemoveAsset(assetId: string) {
    setAssets((prev) => prev.filter((asset) => asset.id !== assetId));
  }

  async function handleCreate() {
    if (!project || assets.length === 0) return;

    setCreateError(null);
    const timeline = autoAssembleTimeline(assets, {
      scriptTemplate,
      attributes: project.attributes,
    });

    try {
      await saveTimeline(projectId, timeline);
      await startRender(timeline);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create this reel");
    }
  }

  if (loadError) {
    return <p className="p-4 text-sm text-red-600">Couldn&apos;t load this reel: {loadError}</p>;
  }
  if (!project) {
    return <p className="p-4 text-sm text-neutral-500">Loading…</p>;
  }

  const details = [formatNicheLabel(project.niche), ...Object.values(project.attributes).map(String)]
    .filter(Boolean)
    .join(" · ");

  const canCreate = assets.length > 0 && !isRendering && (renderStatus === null || isTerminal);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <h1 className="text-lg font-semibold">{project.name}</h1>
        {details && <p className="text-sm text-neutral-500">{details}</p>}
      </div>

      <p className="text-sm text-neutral-600">
        Add a few photos or clips, then create your reel — no manual editing needed.
      </p>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_FILE_TYPES}
        className="hidden"
        onChange={handleFileSelected}
        disabled={isUploading}
      />
      <button
        className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        onClick={() => fileInputRef.current?.click()}
        disabled={isUploading}
      >
        {isUploading ? "Uploading…" : "+ Add photo or clip"}
      </button>

      {uploadError && <p className="text-sm text-red-600">{uploadError}</p>}
      {assetsError && <p className="text-sm text-red-600">Couldn&apos;t load assets: {assetsError}</p>}

      {assets.length === 0 ? (
        <p className="text-sm text-neutral-500">Nothing added yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {assets.map((asset) => (
            <li
              key={asset.id}
              className="flex items-center justify-between rounded-md border border-neutral-300 px-3 py-2 text-sm"
            >
              <span className="truncate">{asset.filename}</span>
              <button
                onClick={() => handleRemoveAsset(asset.id)}
                className="ml-2 shrink-0 text-neutral-500 hover:text-red-600"
                aria-label={`Remove ${asset.filename}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
        onClick={handleCreate}
        disabled={!canCreate}
      >
        {isRendering ? "Starting render…" : "Create My Reel"}
      </button>

      {createError && <p className="text-sm text-red-600">{createError}</p>}
      {renderError && <p className="text-sm text-red-600">{renderError}</p>}
      {renderStatus && (
        <p className="text-sm text-neutral-600">
          Status: <span className="font-medium">{renderStatus}</span>
          {renderStatus === "completed" && renderUrl && (
            <>
              {" — "}
              <a href={renderUrl} target="_blank" rel="noreferrer" className="underline">
                view your reel
              </a>
            </>
          )}
        </p>
      )}
    </div>
  );
}
