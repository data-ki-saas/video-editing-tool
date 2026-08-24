"use client";

import { useRef, useState } from "react";
import { uploadAssetWithProgress, type Asset } from "@/lib/api";
import { downscaleImageIfNeeded } from "@/lib/image";

const ACCEPTED_FILE_TYPES = "video/mp4,image/jpeg,image/png";

export function UploadPanel({
  projectId,
  onUploaded,
  onUploadingChange,
}: {
  projectId: string;
  onUploaded: (asset: Asset) => void;
  // Lets the sidebar show a busy spinner on the Upload action even when the
  // user has switched to a different panel mid-upload.
  onUploadingChange?: (isUploading: boolean) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [lastUploaded, setLastUploaded] = useState<string | null>(null);

  async function upload(file: File) {
    setIsUploading(true);
    onUploadingChange?.(true);
    setProgress(0);
    setError(null);
    setLastUploaded(null);
    try {
      const uploadFile = await downscaleImageIfNeeded(file);
      const asset = await uploadAssetWithProgress(projectId, uploadFile, setProgress);
      onUploaded(asset);
      setLastUploaded(asset.filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);
      onUploadingChange?.(false);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    if (isUploading) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void upload(file);
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // lets the same file be re-selected later
    if (file) void upload(file);
  }

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Upload video or image</h2>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        onClick={() => !isUploading && fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        aria-disabled={isUploading}
        className={
          "flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-10 text-center text-sm " +
          (isUploading
            ? "cursor-not-allowed border-border text-muted"
            : isDragging
              ? "cursor-pointer border-accent bg-accent/10"
              : "cursor-pointer border-border text-muted hover:bg-background")
        }
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_FILE_TYPES}
          className="hidden"
          onChange={handleFileSelected}
          disabled={isUploading}
        />
        <span>Drag &amp; drop a video or image here, or click to browse</span>
        <span className="text-xs">MP4, JPG, or PNG</span>
      </div>

      {isUploading && (
        <div className="flex flex-col gap-1">
          <div className="h-2 w-full overflow-hidden rounded-full bg-border">
            <div
              className="h-full bg-accent transition-[width]"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <span className="text-xs text-muted">Uploading… {Math.round(progress * 100)}%</span>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!isUploading && !error && lastUploaded && (
        <p className="text-sm text-emerald-700">Uploaded {lastUploaded}</p>
      )}
    </div>
  );
}
