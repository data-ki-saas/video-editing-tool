/**
 * Server-side Open Graph / Twitter metadata for the public share page.
 * page.tsx is a client component that only loads the video after hydration,
 * and social crawlers (Facebook, WhatsApp, X, ...) don't run JS -- without
 * tags in the initial HTML a shared link previews as bare text with no
 * video/image. Plain fetch (not lib/api's getPublicLibraryVideo) since that
 * one builds a browser Supabase client for its auth header.
 */
import type { Metadata } from "next";
import { SITE_URL } from "@/lib/siteUrl";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

interface PublicVideoWire {
  project_name: string;
  description: string | null;
  video_url: string;
  thumbnail_url: string | null;
}

export async function generateMetadata({ params }: { params: Promise<{ videoId: string }> }): Promise<Metadata> {
  const { videoId } = await params;
  try {
    const response = await fetch(`${API_BASE_URL}/api/library/public/${encodeURIComponent(videoId)}`, {
      next: { revalidate: 300 },
    });
    if (!response.ok) return { title: "Shared reel" };
    const video = (await response.json()) as PublicVideoWire;
    const title = video.project_name || "Shared reel";
    const description = video.description || "Made with myReels";
    const pageUrl = `${SITE_URL}/share/${videoId}`;
    return {
      title,
      description,
      openGraph: {
        type: "video.other",
        title,
        description,
        url: pageUrl,
        siteName: "myReels",
        images: video.thumbnail_url ? [{ url: video.thumbnail_url }] : undefined,
        videos: [{ url: video.video_url, secureUrl: video.video_url, type: "video/mp4" }],
      },
      twitter: {
        card: video.thumbnail_url ? "summary_large_image" : "summary",
        title,
        description,
        images: video.thumbnail_url ? [video.thumbnail_url] : undefined,
      },
    };
  } catch {
    return { title: "Shared reel" };
  }
}

export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return children;
}
