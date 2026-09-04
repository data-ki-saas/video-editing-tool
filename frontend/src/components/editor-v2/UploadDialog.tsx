"use client";

/** Modal wrapper around the existing UploadPanel, opened by AssetGallery's
 * "+ Asset" button instead of a dropzone being permanently on screen. */
import { UploadPanel } from "@/components/editor-panels/UploadPanel";
import type { Asset } from "@/lib/api";

export function UploadDialog({
  projectId,
  onUploaded,
  onUploadingChange,
  onClose,
}: {
  projectId: string;
  onUploaded: (asset: Asset) => void;
  onUploadingChange?: (isUploading: boolean) => void;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Upload asset"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Add an asset</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        <UploadPanel projectId={projectId} onUploaded={onUploaded} onUploadingChange={onUploadingChange} />
      </div>
    </div>
  );
}
