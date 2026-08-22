"use client";

/**
 * Top band of the three-pane editor, left to right: the project switcher
 * (replaces the removed left navigation sidebar), this project's asset
 * gallery (replaces the always-visible upload dropzone -- "+ Asset" opens
 * UploadDialog instead), and a play area showing whichever asset is
 * currently selected.
 */
import { useState } from "react";
import { ProjectList } from "./ProjectList";
import { AssetGallery } from "./AssetGallery";
import { UploadDialog } from "./UploadDialog";
import type { Asset } from "@/lib/api";

export function ActionArea({
  projectId,
  assets,
  selectedAsset,
  onSelectAsset,
  onUploaded,
  onUploadingChange,
}: {
  projectId: string;
  assets: Asset[];
  selectedAsset: Asset | null;
  onSelectAsset: (asset: Asset) => void;
  onUploaded: (asset: Asset) => void;
  onUploadingChange?: (isUploading: boolean) => void;
}) {
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);

  return (
    <div className="flex h-full gap-4 p-4">
      <div className="w-44 shrink-0 overflow-hidden border-r border-border pr-4">
        <ProjectList activeProjectId={projectId} />
      </div>

      <div className="w-64 shrink-0 overflow-hidden">
        <AssetGallery
          assets={assets}
          selectedAssetId={selectedAsset?.id ?? null}
          onSelect={onSelectAsset}
          onAddAsset={() => setIsUploadDialogOpen(true)}
        />
      </div>

      <div className="flex min-w-0 flex-1 items-center justify-center rounded-md border border-border bg-neutral-950">
        {selectedAsset?.kind === "video" ? (
          <video
            key={selectedAsset.id}
            src={selectedAsset.url}
            controls
            className="h-full max-h-full w-full max-w-full object-contain"
          />
        ) : selectedAsset?.kind === "image" ? (
          // eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned URL, not a Next-optimizable static asset
          <img
            key={selectedAsset.id}
            src={selectedAsset.url}
            alt={selectedAsset.filename}
            className="h-full max-h-full w-full max-w-full object-contain"
          />
        ) : (
          <p className="p-4 text-sm text-muted">Upload a video to start editing</p>
        )}
      </div>

      {isUploadDialogOpen && (
        <UploadDialog
          projectId={projectId}
          onUploaded={(asset) => {
            onUploaded(asset);
            setIsUploadDialogOpen(false);
          }}
          onUploadingChange={onUploadingChange}
          onClose={() => setIsUploadDialogOpen(false)}
        />
      )}
    </div>
  );
}
