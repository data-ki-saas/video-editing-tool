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
 * asset list, which one is selected) and the thumbnail/volume extraction
 * pipeline; each band below is otherwise a plain, mostly-stateless view.
 */
import { useCallback, useEffect, useState } from "react";
import { listAssets, type Asset } from "@/lib/api";
import { extractThumbnails } from "@/lib/video/video";
import { extractVolumeProfile } from "@/lib/video/audio";
import { ActionArea } from "./ActionArea";
import { Playground } from "./Playground";
import { FeedbackArea } from "./FeedbackArea";

const THUMBNAIL_INTERVAL_SECONDS = 1;
const VOLUME_BUCKET_SECONDS = 1;

export function ThreePaneEditor({ projectId }: { projectId: string }) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [assetsError, setAssetsError] = useState<string | null>(null);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [volumeLevels, setVolumeLevels] = useState<number[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

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
  // graph whenever the selection changes. The two extractions run
  // concurrently and update state independently (rather than waiting on
  // Promise.all to fully resolve) so the Playground can render whichever
  // finishes first instead of blocking on the slower of the two.
  useEffect(() => {
    // Resets the previous asset's extraction results as soon as the
    // selection changes, rather than leaving stale thumbnails/levels on
    // screen while the new asset's extraction is still in flight.
    if (!selectedAsset || selectedAsset.kind !== "video") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setThumbnails([]);
      setVolumeLevels([]);
      setAnalysisError(null);
      return;
    }

    let cancelled = false;
    setIsAnalyzing(true);
    setAnalysisError(null);
    setThumbnails([]);
    setVolumeLevels([]);

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

    Promise.allSettled([thumbnailsDone, volumeDone]).then(() => {
      if (!cancelled) setIsAnalyzing(false);
    });

    return () => {
      cancelled = true;
    };
  }, [selectedAsset]);

  function handleUploaded(asset: Asset) {
    setAssets((prev) => [asset, ...prev]);
    setSelectedAsset(asset);
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
        />
      </section>

      <section style={{ flexBasis: "50%" }} className="shrink-0 overflow-hidden border-b border-border">
        <Playground thumbnails={thumbnails} volumeLevels={volumeLevels} isAnalyzing={isAnalyzing} />
      </section>

      <section style={{ flexBasis: "20%" }} className="shrink-0 overflow-y-auto">
        <FeedbackArea
          assetsError={assetsError}
          analysisError={analysisError}
          isAnalyzing={isAnalyzing}
          isUploading={isUploading}
        />
      </section>
    </div>
  );
}
