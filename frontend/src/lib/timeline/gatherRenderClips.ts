"use client";

/**
 * Client-side prep for a render: resolves each clip/track's REAL duration
 * right before rendering, sequentially (bounds concurrent network/decode
 * load, same reasoning as CanvasPlayer's own sequential loading). Kept
 * separate from lib/timeline/compileCreatomateTimeline.ts, which imports
 * the `creatomate` package and therefore must never end up in the browser
 * bundle -- this file only touches plain browser APIs (video.ts/audio.ts)
 * and is safe to import directly from ThreePaneEditor.tsx.
 *
 * Only durations travel over the wire to /api/render (via
 * CompileTimelineInput) -- not URLs, since the compiler only needs each
 * clip's assetId (for `_appMeta`) and duration; a fresh, non-expired
 * presigned URL is resolved server-side from the assetId right before the
 * actual Creatomate call (see resolveAssetSources in api/render/route.ts).
 */
import { getVideoDuration } from "@/lib/video/video";
import { getAudioDuration } from "@/lib/video/audio";
import { buildSequenceClipInfos, type SequenceClipInfo, type SequenceEntry } from "@/lib/video/video_math";

export async function gatherSequenceClipInfos(
  clips: (SequenceEntry & { url: string })[]
): Promise<SequenceClipInfo[]> {
  const clipMeta: { assetId: string; url: string; durationSeconds: number; kind: "video" | "image" }[] = [];
  for (const clip of clips) {
    if (clip.kind === "image") {
      // No file to probe -- an image clip's duration is authored (see
      // lib/video/imageTemplates.ts), not read from anywhere.
      clipMeta.push({ assetId: clip.assetId, url: clip.url, durationSeconds: clip.durationSeconds, kind: "image" });
      continue;
    }
    try {
      const durationSeconds = await getVideoDuration(clip.url);
      clipMeta.push({ assetId: clip.assetId, url: clip.url, durationSeconds, kind: "video" });
    } catch {
      // Skipped -- same "one bad clip shouldn't block the rest" policy as
      // CanvasPlayer's own sequence loading.
    }
  }
  return buildSequenceClipInfos(clipMeta);
}

export async function gatherBackgroundClipInfos(
  tracks: { assetId: string | null; name: string; url: string }[]
): Promise<SequenceClipInfo[]> {
  // A curated catalog track (assetId null -- see BackgroundTrackSelector.tsx
  // /lib/backgroundTracks.ts) has no project asset to resolve a render-time
  // URL from, unlike a project asset track. BACKGROUND_TRACK_OPTIONS has no
  // real (non-"none") entries yet, so this never actually fires today --
  // revisit (bake the catalog URL directly into the compiled element,
  // bypassing _appMeta) once a real one exists.
  const resolvable = tracks.filter((track): track is { assetId: string; name: string; url: string } => track.assetId !== null);

  const clipMeta: { assetId: string; url: string; durationSeconds: number }[] = [];
  for (const track of resolvable) {
    try {
      const durationSeconds = await getAudioDuration(track.url);
      clipMeta.push({ assetId: track.assetId, url: track.url, durationSeconds });
    } catch {
      // Skipped -- same "one bad track shouldn't block the rest" policy as above.
    }
  }
  return buildSequenceClipInfos(clipMeta);
}
