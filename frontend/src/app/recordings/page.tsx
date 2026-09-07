"use client";

/**
 * This user's own camera recordings/photos -- everything saved via the
 * Record button (CameraCapturePage.tsx, dashboard/[projectId]/record),
 * reachable from TopMenuBar's spool icon next to Library. Structured as a
 * close cousin of app/library/page.tsx's LibraryCard/LibraryPageContent
 * (same InlineEditableText name, description textarea, optimistic update/
 * delete convention) -- the two differ mainly in what a card can DO: a
 * recording additionally opens RecordingEditDialog to trim (video) or crop
 * (photo) it in place, and there's no All/Templates tab split here (not
 * asked for -- recordings are just one flat "newest first" list). Pulling a
 * recording into a specific reel happens from the editor's own "+Asset"
 * popup (its new Recordings tab), not from this page.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { deleteRecording, listRecordings, updateRecording, type Recording } from "@/lib/api";
import { CropToolIcon, SpeakerFullIcon, SpeakerMutedIcon, TrashIcon } from "@/components/icons/UIIcons";
import { InlineEditableText } from "@/components/InlineEditableText";
import { RecordingEditDialog } from "@/components/recordings/RecordingEditDialog";

const DESCRIPTION_MAX_LENGTH = 120;

function formatDuration(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatSavedAt(iso: string): string {
  return new Date(iso).toLocaleString();
}

function RecordingCard({
  recording,
  onUpdateMetadata,
  onDelete,
  onEdit,
}: {
  recording: Recording;
  onUpdateMetadata: (recording: Recording, next: { name: string; description: string | null }) => void;
  onDelete: (recording: Recording) => void;
  onEdit: (recording: Recording) => void;
}) {
  // Autoplays muted+looped by default, same reasoning as LibraryCard's own
  // isMuted -- browsers only allow autoplay at all when muted.
  const [isMuted, setIsMuted] = useState(true);
  const [description, setDescription] = useState(recording.description ?? "");
  const duration = formatDuration(recording.durationSeconds);

  function handleDescriptionBlur() {
    const trimmed = description.trim();
    if (trimmed === (recording.description ?? "")) return;
    onUpdateMetadata(recording, { name: recording.name, description: trimmed || null });
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
      <div className="relative aspect-[9/16] overflow-hidden rounded-md bg-black">
        {recording.kind === "video" ? (
          <>
            <video
              src={recording.url}
              autoPlay
              loop
              muted={isMuted}
              playsInline
              className="h-full w-full object-cover"
            />
            <button
              type="button"
              onClick={() => setIsMuted((prev) => !prev)}
              title={isMuted ? "Unmute" : "Mute"}
              aria-label={isMuted ? "Unmute" : "Mute"}
              className="absolute right-1 top-1 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80"
            >
              {isMuted ? <SpeakerMutedIcon className="h-3.5 w-3.5" /> : <SpeakerFullIcon className="h-3.5 w-3.5" />}
            </button>
            {duration && (
              <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[10px] text-white">
                {duration}
              </span>
            )}
          </>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- a short-lived presigned R2 URL, not a Next-optimizable static asset
          <img src={recording.url} alt={recording.name} className="h-full w-full object-cover" />
        )}
      </div>

      <InlineEditableText
        value={recording.name}
        onCommit={(name) => onUpdateMetadata(recording, { name, description: recording.description })}
        ariaLabel="Recording name"
        className="truncate text-xs font-medium text-foreground"
        inputClassName="block w-full truncate rounded border border-border px-1 text-xs font-medium text-foreground outline-none"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value.slice(0, DESCRIPTION_MAX_LENGTH))}
        onBlur={handleDescriptionBlur}
        placeholder="Add a description…"
        maxLength={DESCRIPTION_MAX_LENGTH}
        rows={2}
        aria-label="Description"
        className="w-full resize-none rounded border border-transparent bg-transparent px-1 text-[10px] text-muted outline-none hover:border-border focus:border-border"
      />
      <p className="text-[10px] text-muted">{formatSavedAt(recording.createdAt)}</p>
      <div className="mt-1 flex items-center gap-1">
        <button
          type="button"
          onClick={() => onEdit(recording)}
          title={recording.kind === "video" ? "Trim" : "Crop"}
          aria-label={recording.kind === "video" ? "Trim" : "Crop"}
          className="rounded-full p-1.5 text-muted hover:bg-background hover:text-foreground"
        >
          <CropToolIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(recording)}
          title="Delete"
          aria-label="Delete"
          className="rounded-full p-1.5 text-muted hover:bg-background hover:text-red-600"
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default function RecordingsPage() {
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingRecording, setEditingRecording] = useState<Recording | null>(null);

  useEffect(() => {
    listRecordings()
      .then(setRecordings)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your recordings"));
  }, []);

  async function handleUpdateMetadata(recording: Recording, next: { name: string; description: string | null }) {
    const previous = { name: recording.name, description: recording.description };
    setRecordings((prev) => prev?.map((r) => (r.id === recording.id ? { ...r, ...next } : r)) ?? prev);
    try {
      await updateRecording(recording.id, next);
    } catch (err) {
      setRecordings((prev) => prev?.map((r) => (r.id === recording.id ? { ...r, ...previous } : r)) ?? prev);
      setError(err instanceof Error ? err.message : "Failed to save changes");
    }
  }

  async function handleDeleteRecording(recording: Recording) {
    if (!window.confirm(`Delete "${recording.name}"? This can't be undone.`)) return;
    const previousIndex = recordings?.findIndex((r) => r.id === recording.id) ?? -1;
    setRecordings((prev) => prev?.filter((r) => r.id !== recording.id) ?? prev);
    try {
      await deleteRecording(recording.id);
    } catch (err) {
      setRecordings((prev) => {
        if (!prev) return prev;
        const next = [...prev];
        next.splice(previousIndex < 0 ? next.length : previousIndex, 0, recording);
        return next;
      });
      setError(err instanceof Error ? err.message : "Failed to delete this recording");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-12">
      <div>
        <Link href="/dashboard" className="text-sm text-muted hover:underline">
          ← Reels
        </Link>
        <h1 className="text-2xl font-semibold">Recordings</h1>
        <p className="text-sm text-muted">
          Videos and photos you&apos;ve recorded from the app, newest first. Add one to a reel from that
          project&apos;s &quot;+Asset&quot; panel.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && !recordings && <p className="text-sm text-muted">Loading…</p>}
      {recordings && recordings.length === 0 && (
        <p className="text-sm text-muted">
          Nothing here yet -- open a reel and tap the record button to capture a video or photo.
        </p>
      )}

      {recordings && recordings.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {recordings.map((recording) => (
            <RecordingCard
              key={recording.id}
              recording={recording}
              onUpdateMetadata={handleUpdateMetadata}
              onDelete={handleDeleteRecording}
              onEdit={setEditingRecording}
            />
          ))}
        </div>
      )}

      {editingRecording && (
        <RecordingEditDialog
          recording={editingRecording}
          onSave={(updated) => {
            setRecordings((prev) => prev?.map((r) => (r.id === updated.id ? updated : r)) ?? prev);
            setEditingRecording(null);
          }}
          onClose={() => setEditingRecording(null)}
        />
      )}
    </main>
  );
}
