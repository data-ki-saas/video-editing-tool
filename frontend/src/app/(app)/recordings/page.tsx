"use client";

/**
 * This user's own camera recordings/photos -- everything saved via the
 * Record button (CameraCapturePage.tsx, either project-scoped at
 * dashboard/[projectId]/record or this page's own project-agnostic
 * recordings/record), reachable from TopMenuBar's spool icon next to
 * Library. Structured as a close cousin of app/library/page.tsx's
 * LibraryCard/LibraryPageContent (same InlineEditableText name, description
 * textarea, optimistic update/delete convention) -- the two differ mainly
 * in what a card can DO: a recording additionally opens RecordingEditDialog
 * to trim (video) or crop (photo) it in place, and there's no All/Templates
 * tab split here (not asked for -- recordings are just one flat "newest
 * first" list). Pulling a recording into a specific reel happens from the
 * editor's own "+Asset" popup (its own Recordings tab), not from this page.
 *
 * This page's own Record/Upload buttons are the two ways a recording gets
 * added here directly (as opposed to via a project's own record button):
 * Record opens the same CameraCapturePage as every other Record entry
 * point; Upload opens RecordingUploadDialog, which is where the "3 minutes
 * / 30fps" limits on an uploaded (not recorded) video are enforced.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { deleteRecording, listRecordings, updateRecording, type Recording } from "@/lib/api";
import {
  CropToolIcon,
  DownloadIcon,
  ShareIcon,
  SpeakerFullIcon,
  SpeakerMutedIcon,
  TrashIcon,
  UploadIcon,
} from "@/components/icons/UIIcons";
import { CollapseIcon, ExpandIcon, PauseIcon, PlayIcon, RecordIcon } from "@/components/editor-v2/icons/PlayerIcons";
import { InlineEditableText } from "@/components/InlineEditableText";
import { RecordingEditDialog } from "@/components/recordings/RecordingEditDialog";
import { RecordingUploadDialog } from "@/components/recordings/RecordingUploadDialog";
import { useCrossOriginImageSrc } from "@/lib/useCrossOriginImageSrc";
import { useCrossOriginVideoSrc } from "@/lib/useCrossOriginVideoSrc";

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

function fileExtensionFor(recording: Recording): string {
  return recording.kind === "video" ? "mp4" : "jpg";
}

// Forces a real download of a cross-origin file -- a plain <a download> is
// silently ignored cross-origin by most browsers, same reasoning as
// app/library/page.tsx's own downloadVideo. Re-fetching as a Blob first
// sidesteps that restriction.
async function downloadRecording(recording: Recording) {
  const blob = await fetch(recording.url).then((res) => res.blob());
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `${recording.name || "recording"}.${fileExtensionFor(recording)}`;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

// Recordings live in the PRIVATE uploads bucket (no public URL to hand out
// -- unlike library/page.tsx's shareVideo, which copies a /share/[videoId]
// link backed by the public renders bucket), so "Share" here hands the OS
// share sheet the actual file bytes instead of a link -- AirDrop/Messages/
// etc. all accept that. Falls back to a plain download when the browser
// can't share files at all (desktop Safari/Firefox, or no Web Share
// support), since there's no link to fall back to.
async function shareRecording(recording: Recording) {
  const blob = await fetch(recording.url).then((res) => res.blob());
  const file = new File([blob], `${recording.name || "recording"}.${fileExtensionFor(recording)}`, {
    type: recording.mimeType,
  });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: recording.name });
      return;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return; // user dismissed the share sheet
      throw err;
    }
  }

  await downloadRecording(recording);
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
  // Unlike LibraryCard's video (which autoplays muted+looped, feed-style),
  // a recording starts paused on its first frame -- explicit Play/Stop
  // below is the whole point of this control, not just a mute toggle on
  // something already running.
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaContainerRef = useRef<HTMLDivElement>(null);
  const [isMuted, setIsMuted] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [description, setDescription] = useState(recording.description ?? "");
  const [actionError, setActionError] = useState<string | null>(null);
  const duration = formatDuration(recording.durationSeconds);
  // Never a plain <video src>/<img src> against recording.url -- see
  // crossOriginVideo.ts's own module comment for why that can poison the
  // browser's cache against RecordingEditDialog's later CORS-mode fetch of
  // the identical URL when Trim/Crop is opened on this same card.
  const videoSrc = useCrossOriginVideoSrc(recording.kind === "video" ? recording.url : null);
  const imageSrc = useCrossOriginImageSrc(recording.kind === "image" ? recording.url : null);

  // Tracks isFullscreen off the browser's own state (not just the click
  // handler) so Escape / the browser's native "exit fullscreen" affordance
  // stay in sync too -- same pattern as CanvasPlayer.tsx's own toggle.
  useEffect(() => {
    function handleFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === mediaContainerRef.current);
    }
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  function handleToggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void mediaContainerRef.current?.requestFullscreen();
    }
  }

  function handleDescriptionBlur() {
    const trimmed = description.trim();
    if (trimmed === (recording.description ?? "")) return;
    onUpdateMetadata(recording, { name: recording.name, description: trimmed || null });
  }

  async function handleDownload() {
    setActionError(null);
    try {
      await downloadRecording(recording);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to download this recording");
    }
  }

  async function handleShare() {
    setActionError(null);
    try {
      await shareRecording(recording);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Failed to share this recording");
    }
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
    } else {
      // A "Stop", not a "Pause" -- rewinds to the start so replaying always
      // begins from the top rather than resuming mid-clip.
      video.pause();
      video.currentTime = 0;
    }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
      <div ref={mediaContainerRef} className="relative aspect-[9/16] overflow-hidden rounded-md bg-black">
        {recording.kind === "video" ? (
          <>
            <video
              ref={videoRef}
              src={videoSrc ?? undefined}
              loop
              muted={isMuted}
              playsInline
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              className="h-full w-full object-cover"
            />
            <button
              type="button"
              onClick={togglePlayback}
              title={isPlaying ? "Stop" : "Play"}
              aria-label={isPlaying ? "Stop" : "Play"}
              className="absolute left-1 top-1 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80"
            >
              {isPlaying ? <PauseIcon className="h-3.5 w-3.5" /> : <PlayIcon className="h-3.5 w-3.5" />}
            </button>
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
          // eslint-disable-next-line @next/next/no-img-element -- a same-origin blob: URL (useCrossOriginImageSrc), not a Next-optimizable static asset
          imageSrc && <img src={imageSrc} alt={recording.name} className="h-full w-full object-cover" />
        )}
        <button
          type="button"
          onClick={handleToggleFullscreen}
          title={isFullscreen ? "Exit full screen" : "Full screen"}
          aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
          className="absolute bottom-1 left-1 rounded-full bg-black/60 p-1.5 text-white hover:bg-black/80"
        >
          {isFullscreen ? <CollapseIcon className="h-3.5 w-3.5" /> : <ExpandIcon className="h-3.5 w-3.5" />}
        </button>
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
          onClick={() => void handleDownload()}
          title="Download"
          aria-label="Download"
          className="rounded-full p-1.5 text-muted hover:bg-background hover:text-foreground"
        >
          <DownloadIcon className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => void handleShare()}
          title="Share"
          aria-label="Share"
          className="rounded-full p-1.5 text-muted hover:bg-background hover:text-foreground"
        >
          <ShareIcon className="h-4 w-4" />
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
      {actionError && <p className="text-[10px] text-red-600">{actionError}</p>}
    </div>
  );
}

export default function RecordingsPage() {
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingRecording, setEditingRecording] = useState<Recording | null>(null);
  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);

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
      <div className="flex flex-wrap items-start justify-between gap-4">
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
        <div className="flex shrink-0 gap-2">
          <Link
            href="/recordings/record"
            className="flex items-center gap-1.5 rounded-md bg-neutral-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-600"
          >
            <RecordIcon className="h-4 w-4" />
            Record
          </Link>
          <button
            type="button"
            onClick={() => setIsUploadDialogOpen(true)}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface"
          >
            <UploadIcon className="h-4 w-4" />
            Upload
          </button>
        </div>
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

      {isUploadDialogOpen && (
        <RecordingUploadDialog
          onUploaded={(recording) => setRecordings((prev) => (prev ? [recording, ...prev] : [recording]))}
          onClose={() => setIsUploadDialogOpen(false)}
        />
      )}
    </main>
  );
}
