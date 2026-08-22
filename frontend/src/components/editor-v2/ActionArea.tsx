"use client";

/**
 * Top band of the three-pane editor: the upload box on the left (reuses the
 * existing UploadPanel unchanged), a play area on the right showing whatever
 * asset is currently selected -- the same asset the Playground unfolds into
 * a thumbnail strip + volume graph below.
 */
import { UploadPanel } from "@/components/editor-panels/UploadPanel";
import type { Asset } from "@/lib/api";

export function ActionArea({
  projectId,
  selectedAsset,
  onUploaded,
  onUploadingChange,
}: {
  projectId: string;
  selectedAsset: Asset | null;
  onUploaded: (asset: Asset) => void;
  onUploadingChange?: (isUploading: boolean) => void;
}) {
  return (
    <div className="flex h-full gap-4 p-4">
      <div className="w-full max-w-sm shrink-0 overflow-y-auto">
        <UploadPanel projectId={projectId} onUploaded={onUploaded} onUploadingChange={onUploadingChange} />
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
    </div>
  );
}
