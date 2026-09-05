"use client";

import { useEffect, useState } from "react";
import { getSocialAccounts, publishSocialPost } from "@/lib/api";
import { pollSocialPost } from "@/lib/socialPost";
import { usePermissions } from "@/lib/usePermissions";
import { UploadIcon } from "@/components/icons/UIIcons";

type PostState = "idle" | "posting" | "completed" | "failed";

/**
 * One-click "Post to YouTube" for an already-saved library video -- shared
 * by LocalRenderPopup.tsx (right after "Save to library" succeeds) and the
 * library page's own per-card action row, so neither duplicates the
 * publish/poll logic. No title/description dialog on purpose: the reel's
 * own saved name is the title, matching this app's "smart defaults over
 * exposing every knob" bias (see root CLAUDE.md's driving vision) -- a
 * picker can follow later if that turns out to matter.
 *
 * `variant="button"` renders a full-width labeled button (next to Download/
 * Save to library in LocalRenderPopup); `variant="icon"` renders a round
 * icon-only button matching the library page's existing Download/Share/
 * Delete action row.
 */
export function PostToYoutubeButton({
  libraryVideoId,
  title,
  variant = "button",
}: {
  libraryVideoId: string;
  title: string;
  variant?: "button" | "icon";
}) {
  const { loading: isLoadingPermissions, has: hasFeature } = usePermissions();
  const [isConnected, setIsConnected] = useState<boolean | null>(null);
  const [state, setState] = useState<PostState>("idle");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getSocialAccounts()
      .then((accounts) => setIsConnected(accounts.some((a) => a.provider === "youtube")))
      .catch(() => setIsConnected(false));
  }, []);

  async function handleClick() {
    if (state === "posting") return;
    if (state === "completed" && videoUrl) {
      window.open(videoUrl, "_blank", "noreferrer");
      return;
    }
    setState("posting");
    setError(null);
    try {
      const post = await publishSocialPost("youtube", libraryVideoId, title, "");
      const finished = await pollSocialPost(post.id);
      if (finished.status === "completed" && finished.providerUrl) {
        setVideoUrl(finished.providerUrl);
        setState("completed");
      } else if (finished.status === "failed") {
        setState("failed");
        setError(finished.error ?? "Failed to post to YouTube");
      } else {
        // Still "processing" past the poll budget -- not a failure, just
        // slow (a big reel's resumable upload can take a while); let the
        // user check back rather than claim it failed.
        setState("idle");
        setError("This is taking longer than usual -- try again in a bit.");
      }
    } catch (err) {
      setState("failed");
      setError(err instanceof Error ? err.message : "Failed to post to YouTube");
    }
  }

  // Fails closed while loading/uncertain, same convention usePermissions'
  // own doc comment states -- no button flashes in only to disappear once
  // the real permission/connection state resolves a moment later.
  if (isLoadingPermissions || isConnected === null) return null;
  if (!hasFeature("social_posting")) return null;

  if (!isConnected) {
    return variant === "icon" ? null : (
      <a
        href="/settings"
        className="flex-1 rounded-md border border-dashed border-border py-1.5 text-center text-sm text-muted hover:bg-background"
      >
        Connect YouTube to post reels
      </a>
    );
  }

  const label = state === "posting" ? "Posting…" : state === "completed" ? "Posted -- view" : "Post to YouTube";

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={state === "posting"}
        title={error ?? label}
        aria-label={label}
        className={`rounded-full p-1.5 hover:bg-background disabled:opacity-50 ${
          state === "completed" ? "text-accent" : state === "failed" ? "text-red-600" : "text-muted hover:text-foreground"
        }`}
      >
        <UploadIcon className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={state === "posting"}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border py-1.5 text-sm font-medium text-foreground hover:bg-background disabled:opacity-50"
      >
        <UploadIcon className="h-4 w-4" />
        {label}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
