"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  deleteLibraryVideo,
  listLibraryVideos,
  setLibraryVideoTemplate,
  updateLibraryVideo,
  type LibraryVideo,
} from "@/lib/api";
import { BookmarkIcon, DownloadIcon, ShareIcon, SpeakerFullIcon, SpeakerMutedIcon, TrashIcon } from "@/components/icons/UIIcons";
import { InlineEditableText } from "@/components/InlineEditableText";

const DESCRIPTION_MAX_LENGTH = 120;

type Tab = "all" | "templates";

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

// Forces a real download of a cross-origin file -- a plain <a download> is
// silently ignored cross-origin by most browsers (it only reliably works
// for same-origin or blob:/data: URLs, see LocalRenderPopup's own Download
// link, which IS same-origin since it's a blob: URL). Re-fetching as a
// Blob first sidesteps that restriction.
async function downloadVideo(video: LibraryVideo) {
  const blob = await fetch(video.videoUrl).then((res) => res.blob());
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = `${video.projectName || "reel"}.mp4`;
  link.click();
  URL.revokeObjectURL(objectUrl);
}

async function shareVideo(video: LibraryVideo) {
  const url = `${window.location.origin}/share/${video.id}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: video.projectName, url });
      return;
    } catch {
      // User dismissed the native share sheet, or it's unavailable for this
      // URL -- fall through to a plain clipboard copy instead of failing silently.
    }
  }
  await navigator.clipboard.writeText(url);
  return url;
}

function LibraryCard({
  video,
  onToggleTemplate,
  onUpdateMetadata,
  onDelete,
}: {
  video: LibraryVideo;
  onToggleTemplate: (video: LibraryVideo) => void;
  onUpdateMetadata: (video: LibraryVideo, next: { projectName: string; description: string | null }) => void;
  onDelete: (video: LibraryVideo) => void;
}) {
  const [copied, setCopied] = useState(false);
  // Autoplays muted+looped by default (browsers only allow autoplay at all
  // when muted, same reason every silent Instagram/TikTok-style feed
  // preview works this way) -- the speaker button just flips .muted on the
  // already-playing element, which unlike starting playback itself needs
  // no separate autoplay-policy handling since it's a direct user gesture.
  const [isMuted, setIsMuted] = useState(true);
  const [description, setDescription] = useState(video.description ?? "");
  const duration = formatDuration(video.durationSeconds);

  async function handleShare() {
    const copiedUrl = await shareVideo(video);
    if (copiedUrl) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function handleDescriptionBlur() {
    const trimmed = description.trim();
    if (trimmed === (video.description ?? "")) return;
    onUpdateMetadata(video, { projectName: video.projectName, description: trimmed || null });
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
      <div className="relative aspect-[9/16] overflow-hidden rounded-md bg-black">
        <video
          src={video.videoUrl}
          poster={video.thumbnailUrl ?? undefined}
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
      </div>

      <InlineEditableText
        value={video.projectName}
        onCommit={(name) => onUpdateMetadata(video, { projectName: name, description: video.description })}
        ariaLabel="Reel name"
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
      <p className="text-[10px] text-muted">{formatSavedAt(video.createdAt)}</p>
      <div className="mt-1 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => downloadVideo(video)}
            title="Download"
            aria-label="Download"
            className="rounded-full p-1.5 text-muted hover:bg-background hover:text-foreground"
          >
            <DownloadIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleShare}
            title="Share"
            aria-label="Share"
            className="rounded-full p-1.5 text-muted hover:bg-background hover:text-foreground"
          >
            <ShareIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => onDelete(video)}
            title="Delete"
            aria-label="Delete"
            className="rounded-full p-1.5 text-muted hover:bg-background hover:text-red-600"
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => onToggleTemplate(video)}
          title={video.isTemplate ? "Remove from templates" : "Save as template"}
          aria-label={video.isTemplate ? "Remove from templates" : "Save as template"}
          className={`rounded-full p-1.5 hover:bg-background ${video.isTemplate ? "text-accent" : "text-muted hover:text-foreground"}`}
        >
          <BookmarkIcon className="h-4 w-4" filled={video.isTemplate} />
        </button>
      </div>
      {copied && <p className="text-[10px] text-accent">Link copied</p>}
    </div>
  );
}

function LibraryPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // `?tab=templates` (see TopMenuBar.tsx/DashboardChromeLayout.tsx/
  // MobileReelMenu.tsx's own Templates shortcut) lands straight on the
  // Templates tab instead of always opening on "All" -- any other/missing
  // value falls back to "all", same graceful-default spirit as this file's
  // other optional fields.
  const initialTab: Tab = searchParams.get("tab") === "templates" ? "templates" : "all";
  const [videos, setVideos] = useState<LibraryVideo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab);

  function handleTabClick(next: Tab) {
    setTab(next);
    // Keeps the URL shareable/bookmarkable at whichever tab is showing --
    // replace (not push) since this is a filter toggle, not a real
    // navigation worth its own back-button stop.
    router.replace(next === "templates" ? `${pathname}?tab=templates` : pathname);
  }

  useEffect(() => {
    listLibraryVideos()
      .then(setVideos)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your library"));
  }, []);

  async function handleToggleTemplate(video: LibraryVideo) {
    const nextIsTemplate = !video.isTemplate;
    // Optimistic -- a failed PATCH is rare and just gets corrected back on
    // the caught error below, not worth a loading state per-card.
    setVideos((prev) => prev?.map((v) => (v.id === video.id ? { ...v, isTemplate: nextIsTemplate } : v)) ?? prev);
    try {
      await setLibraryVideoTemplate(video.id, nextIsTemplate);
    } catch (err) {
      setVideos((prev) => prev?.map((v) => (v.id === video.id ? { ...v, isTemplate: video.isTemplate } : v)) ?? prev);
      setError(err instanceof Error ? err.message : "Failed to update template");
    }
  }

  async function handleUpdateMetadata(video: LibraryVideo, next: { projectName: string; description: string | null }) {
    const previous = { projectName: video.projectName, description: video.description };
    setVideos((prev) => prev?.map((v) => (v.id === video.id ? { ...v, ...next } : v)) ?? prev);
    try {
      await updateLibraryVideo(video.id, next);
    } catch (err) {
      setVideos((prev) => prev?.map((v) => (v.id === video.id ? { ...v, ...previous } : v)) ?? prev);
      setError(err instanceof Error ? err.message : "Failed to save changes");
    }
  }

  async function handleDeleteVideo(video: LibraryVideo) {
    if (!window.confirm(`Delete "${video.projectName}"? This can't be undone.`)) return;
    // Optimistic, same as the toggles above -- restores the row (in its
    // original position) if the DELETE fails.
    const previousIndex = videos?.findIndex((v) => v.id === video.id) ?? -1;
    setVideos((prev) => prev?.filter((v) => v.id !== video.id) ?? prev);
    try {
      await deleteLibraryVideo(video.id);
    } catch (err) {
      setVideos((prev) => {
        if (!prev) return prev;
        const next = [...prev];
        next.splice(previousIndex < 0 ? next.length : previousIndex, 0, video);
        return next;
      });
      setError(err instanceof Error ? err.message : "Failed to delete this video");
    }
  }

  const visibleVideos = videos?.filter((v) => tab === "all" || v.isTemplate) ?? null;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-12">
      <div>
        <Link href="/dashboard" className="text-sm text-muted hover:underline">
          ← Reels
        </Link>
        <h1 className="text-2xl font-semibold">Library</h1>
        <p className="text-sm text-muted">Reels you&apos;ve saved from a finished render, newest first.</p>
      </div>

      <div className="flex gap-2 text-sm">
        {(["all", "templates"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => handleTabClick(option)}
            className={`rounded-md border border-border px-3 py-1 ${
              tab === option ? "bg-accent text-accent-foreground" : "hover:bg-surface"
            }`}
          >
            {option === "all" ? "All" : "Templates"}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && !videos && <p className="text-sm text-muted">Loading…</p>}
      {visibleVideos && visibleVideos.length === 0 && (
        <p className="text-sm text-muted">
          {tab === "templates"
            ? "No templates yet -- open a saved reel below and choose \"Save as template.\""
            : "Nothing here yet -- render a reel with Edge Render and choose \"Save to library\" to keep it here."}
        </p>
      )}

      {visibleVideos && visibleVideos.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {visibleVideos.map((video) => (
            <LibraryCard
              key={video.id}
              video={video}
              onToggleTemplate={handleToggleTemplate}
              onUpdateMetadata={handleUpdateMetadata}
              onDelete={handleDeleteVideo}
            />
          ))}
        </div>
      )}
    </main>
  );
}

// useSearchParams (above) requires a Suspense boundary -- see this hook's
// own doc comment; without it a static build of this page fails.
export default function LibraryPage() {
  return (
    <Suspense fallback={<main className="mx-auto w-full max-w-5xl px-4 py-12 text-sm text-muted">Loading…</main>}>
      <LibraryPageContent />
    </Suspense>
  );
}
