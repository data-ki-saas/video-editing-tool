"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { listLibraryVideos, setLibraryVideoTemplate, type LibraryVideo } from "@/lib/api";
import { BookmarkIcon, DownloadIcon, ShareIcon } from "@/components/icons/UIIcons";

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
}: {
  video: LibraryVideo;
  onToggleTemplate: (video: LibraryVideo) => void;
}) {
  const [copied, setCopied] = useState(false);
  const duration = formatDuration(video.durationSeconds);

  async function handleShare() {
    const copiedUrl = await shareVideo(video);
    if (copiedUrl) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
      <a
        href={video.videoUrl}
        target="_blank"
        rel="noreferrer"
        className="relative block aspect-[9/16] overflow-hidden rounded-md bg-black"
      >
        {video.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a public R2 URL, not a Next-optimizable static asset
          <img src={video.thumbnailUrl} alt={video.projectName} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-muted">No preview</div>
        )}
        {duration && (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[10px] text-white">
            {duration}
          </span>
        )}
      </a>
      <p className="truncate text-xs font-medium text-foreground" title={video.projectName}>
        {video.projectName}
      </p>
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

export default function LibraryPage() {
  const [videos, setVideos] = useState<LibraryVideo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");

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
            onClick={() => setTab(option)}
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
            <LibraryCard key={video.id} video={video} onToggleTemplate={handleToggleTemplate} />
          ))}
        </div>
      )}
    </main>
  );
}
