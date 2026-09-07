"use client";

/** Modal wrapper around the existing UploadPanel, opened by AssetGallery's
 * "+ Asset" button instead of a dropzone being permanently on screen. A
 * second tab ("Recordings") lists this user's own camera recordings
 * (/recordings, CameraCapturePage.tsx's Record button) as selectable tiles
 * -- picking one calls addRecordingToProject, which copies its bytes into a
 * fresh row in THIS project's asset list (see the backend's own
 * add_to_project comment for why it's a copy, not a shared reference), then
 * reports back through the same onUploaded callback the Upload tab already
 * uses. Same tab-bar look as StockMediaDialog's own KIND_TABS. */
import { useEffect, useState } from "react";
import { UploadPanel } from "@/components/editor-panels/UploadPanel";
import { addRecordingToProject, listRecordings, type Asset, type Recording } from "@/lib/api";

type Tab = "upload" | "recordings";

function RecordingTile({
  recording,
  isAdding,
  isAdded,
  onAdd,
}: {
  recording: Recording;
  isAdding: boolean;
  isAdded: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-md border border-border bg-background">
      <div className="relative aspect-[9/16] w-full overflow-hidden bg-neutral-900">
        {recording.kind === "video" ? (
          <video src={recording.url} muted playsInline className="h-full w-full object-cover" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- a presigned R2 URL, not a Next-optimizable static asset
          <img src={recording.url} alt={recording.name} className="h-full w-full object-cover" />
        )}
      </div>
      <div className="flex items-center justify-between gap-1 p-1.5">
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted" title={recording.name}>
          {recording.name}
        </span>
        <button
          type="button"
          onClick={onAdd}
          disabled={isAdding || isAdded}
          className="shrink-0 rounded-md bg-accent px-2 py-1 text-[10px] font-medium text-accent-foreground disabled:opacity-50"
        >
          {isAdded ? "Added" : isAdding ? "…" : "Add"}
        </button>
      </div>
    </div>
  );
}

function RecordingsTab({ projectId, onAdded }: { projectId: string; onAdded: (asset: Asset) => void }) {
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addingIds, setAddingIds] = useState<Set<string>>(new Set());
  const [addedIds, setAddedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    listRecordings()
      .then(setRecordings)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your recordings"));
  }, []);

  function handleAdd(recording: Recording) {
    setAddingIds((prev) => new Set(prev).add(recording.id));
    addRecordingToProject(recording.id, projectId)
      .then((asset) => {
        setAddedIds((prev) => new Set(prev).add(recording.id));
        onAdded(asset);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to add this recording"))
      .finally(() =>
        setAddingIds((prev) => {
          const next = new Set(prev);
          next.delete(recording.id);
          return next;
        })
      );
  }

  return (
    <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
      {error && <p className="text-xs text-red-600">{error}</p>}
      {!recordings && !error && <p className="text-center text-xs text-muted">Loading…</p>}
      {recordings && recordings.length === 0 && (
        <p className="text-center text-xs text-muted">
          Nothing here yet -- record a video or take a photo from a reel&apos;s record button first.
        </p>
      )}
      {recordings && recordings.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {recordings.map((recording) => (
            <RecordingTile
              key={recording.id}
              recording={recording}
              isAdding={addingIds.has(recording.id)}
              isAdded={addedIds.has(recording.id)}
              onAdd={() => handleAdd(recording)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

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
  const [tab, setTab] = useState<Tab>("upload");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add an asset"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Add an asset</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="mb-3 flex gap-1">
          {(
            [
              ["upload", "Upload"],
              ["recordings", "Recordings"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={
                "rounded-md px-3 py-1 text-xs font-medium " +
                (tab === id ? "bg-accent text-accent-foreground" : "text-muted hover:bg-background")
              }
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "upload" ? (
          <UploadPanel projectId={projectId} onUploaded={onUploaded} onUploadingChange={onUploadingChange} />
        ) : (
          <RecordingsTab projectId={projectId} onAdded={onUploaded} />
        )}
      </div>
    </div>
  );
}
