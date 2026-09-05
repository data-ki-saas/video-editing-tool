"use client";

/**
 * Public, unauthenticated view of one saved library video -- the target of
 * the library page's "Share" action (see app/library/page.tsx's shareVideo
 * helper). Reachable with no account at all: PUBLIC_SHARE_PATH_PREFIX in
 * lib/supabase/middleware.ts exempts this route from the app's normal
 * auth wall, and the backend call below (getPublicLibraryVideo) carries no
 * auth header on purpose -- see its own comment.
 */
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { getPublicLibraryVideo, type LibraryVideo } from "@/lib/api";

export default function SharedVideoPage({ params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = use(params);
  const [video, setVideo] = useState<LibraryVideo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPublicLibraryVideo(videoId)
      .then(setVideo)
      .catch(() => setError("This shared reel couldn't be found -- it may have been removed."));
  }, [videoId]);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-4 px-4 py-12">
      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && !video && <p className="text-sm text-muted">Loading…</p>}
      {video && (
        <>
          {/* Muted by default -- browsers only allow autoplay at all when
              muted; the native `controls` bar's own speaker icon is how a
              viewer unmutes, same as any other embedded video player. */}
          <video src={video.videoUrl} controls autoPlay loop muted className="max-h-[80vh] w-full rounded-md bg-black" />
          <p className="text-sm font-medium text-foreground">{video.projectName}</p>
        </>
      )}
      <Link href="/" className="text-xs text-muted hover:underline">
        Made with myReels
      </Link>
    </main>
  );
}
