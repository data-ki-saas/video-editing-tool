"use client";

/**
 * Local-render counterpart to lib/timeline/gatherRenderClips.ts -- kept as
 * its own file rather than reusing that one because the two have genuinely
 * different needs: the cloud gatherer only sends durations over the wire (a
 * fresh presigned URL is resolved server-side from each assetId right
 * before the actual Creatomate call). The local exporter runs entirely in
 * this tab and already has a working URL for everything (assetUrlById), so
 * gatherLocalSequenceClips reuses the same duration probes and sequencing
 * math as the cloud path (getVideoDuration/buildSequenceClipInfos).
 *
 * gatherLocalMusicClips below has no such probing to do -- a MusicClip's
 * position/duration are fully authored already (see video_math.ts's own
 * doc comment), so it's a synchronous URL resolve, not an async gatherer.
 */
import { getVideoDurationAndDimensions } from "@/lib/video/video";
import { loadCrossOriginImage } from "@/lib/crossOriginImage";
import { buildSequenceClipInfos, type MusicClip, type ResolvedMusicClip, type SequenceClipInfo, type SequenceEntry } from "@/lib/video/video_math";

export async function gatherLocalSequenceClips(
  clips: (SequenceEntry & { url: string })[]
): Promise<SequenceClipInfo[]> {
  const clipMeta: {
    id: string;
    assetId: string;
    url: string;
    durationSeconds: number;
    kind: "video" | "image" | "text";
    width?: number;
    height?: number;
  }[] = [];
  for (const clip of clips) {
    if (clip.kind === "text") {
      // No file to probe at all -- duration is authored (same as an image
      // cutaway), and drawTextSlide (textSlideRenderer.ts) reads its
      // optional image's real dimensions directly off the loaded
      // HTMLImageElement at draw time, not from here.
      clipMeta.push({ id: clip.id, assetId: clip.assetId, url: clip.url, durationSeconds: clip.durationSeconds, kind: "text" });
      continue;
    }
    if (clip.kind === "image") {
      // Duration is authored (see lib/video/imageTemplates.ts), not read
      // from anywhere -- but dimensions still need probing, same as a
      // video clip, so a render can re-project the sequence's authored
      // crop rect onto this photo's own real aspect ratio
      // (video_math.ts's reprojectCropRect) when it's the reference clip.
      let width: number | undefined;
      let height: number | undefined;
      try {
        const { image, blobUrl } = await loadCrossOriginImage(clip.url);
        width = image.naturalWidth;
        height = image.naturalHeight;
        URL.revokeObjectURL(blobUrl);
      } catch {
        // Dimensions stay unknown -- reprojectCropRect's callers fall back
        // to leaving the authored rect unchanged, same as before this
        // probe existed, rather than blocking the render on it.
      }
      clipMeta.push({ id: clip.id, assetId: clip.assetId, url: clip.url, durationSeconds: clip.durationSeconds, kind: "image", width, height });
      continue;
    }
    try {
      const { durationSeconds, width, height } = await getVideoDurationAndDimensions(clip.url);
      clipMeta.push({ id: clip.id, assetId: clip.assetId, url: clip.url, durationSeconds, kind: "video", width, height });
    } catch {
      // Skipped -- same "one bad clip shouldn't block the rest" policy as
      // CanvasPlayer's own sequence loading.
    }
  }
  return buildSequenceClipInfos(clipMeta);
}

/** Resolves each music clip's assetId to a real URL right before a local
 * render -- no duration probe, no sequencing math (unlike
 * gatherLocalSequenceClips above), since a MusicClip already carries its
 * own authored startTimeSeconds/endTimeSeconds/sourceStartSeconds. Drops a
 * clip whose asset has no resolved URL (deleted since it was placed) rather
 * than failing the whole render over one missing track. */
export function gatherLocalMusicClips(clips: MusicClip[], assetUrlById: Record<string, string>): ResolvedMusicClip[] {
  return clips
    .map((clip) => ({ ...clip, url: assetUrlById[clip.assetId] }))
    .filter((clip): clip is ResolvedMusicClip => Boolean(clip.url));
}
