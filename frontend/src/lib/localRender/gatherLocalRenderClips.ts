"use client";

/**
 * Local-render counterpart to lib/timeline/gatherRenderClips.ts -- kept as
 * its own file rather than reusing that one because the two have genuinely
 * different needs: the cloud gatherer only sends durations over the wire
 * (a fresh presigned URL is resolved server-side from each assetId right
 * before the actual Creatomate call) and drops any background track with a
 * null assetId (no project asset for the server-side compiler's `_appMeta`
 * to key off of). The local exporter runs entirely in this tab, already has
 * a working URL for everything (assetUrlById), and has no `_appMeta`
 * concept at all -- a curated catalog background track works here just
 * fine. Reuses the same duration probes and sequencing math as the cloud
 * path (getVideoDuration/getAudioDuration/buildSequenceClipInfos).
 */
import { getVideoDuration } from "@/lib/video/video";
import { getAudioDuration } from "@/lib/video/audio";
import { buildSequenceClipInfos, type SequenceClipInfo, type SequenceEntry } from "@/lib/video/video_math";

export async function gatherLocalSequenceClips(
  clips: (SequenceEntry & { url: string })[]
): Promise<SequenceClipInfo[]> {
  const clipMeta: { id: string; assetId: string; url: string; durationSeconds: number; kind: "video" | "image" }[] = [];
  for (const clip of clips) {
    if (clip.kind === "image") {
      // No file to probe -- an image clip's duration is authored (see
      // lib/video/imageTemplates.ts), not read from anywhere.
      clipMeta.push({ id: clip.id, assetId: clip.assetId, url: clip.url, durationSeconds: clip.durationSeconds, kind: "image" });
      continue;
    }
    try {
      const durationSeconds = await getVideoDuration(clip.url);
      clipMeta.push({ id: clip.id, assetId: clip.assetId, url: clip.url, durationSeconds, kind: "video" });
    } catch {
      // Skipped -- same "one bad clip shouldn't block the rest" policy as
      // CanvasPlayer's own sequence loading.
    }
  }
  return buildSequenceClipInfos(clipMeta);
}

export async function gatherLocalBackgroundClips(
  tracks: { assetId: string | null; name: string; url: string }[]
): Promise<SequenceClipInfo[]> {
  const clipMeta: { assetId: string; url: string; durationSeconds: number }[] = [];
  for (const [index, track] of tracks.entries()) {
    try {
      const durationSeconds = await getAudioDuration(track.url);
      // A curated catalog track has no real assetId -- synthesize a stable
      // per-position placeholder since SequenceClipInfo needs some key, but
      // nothing here ever looks it up by assetId (unlike the cloud path's
      // _appMeta), so any unique string is fine.
      clipMeta.push({ assetId: track.assetId ?? `catalog-track-${index}`, url: track.url, durationSeconds });
    } catch {
      // Skipped -- same "one bad track shouldn't block the rest" policy as above.
    }
  }
  return buildSequenceClipInfos(clipMeta);
}
