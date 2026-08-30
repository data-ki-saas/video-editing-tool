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
 * Durations and real pixel dimensions travel over the wire to /api/render
 * (via CompileTimelineInput) -- not URLs, since the compiler only needs
 * each clip's assetId (for `_appMeta`), duration, and width/height; a
 * fresh, non-expired presigned URL is resolved server-side from the
 * assetId right before the actual Creatomate call (see resolveAssetSources
 * in api/render/route.ts). Width/height let the server-side compiler
 * re-project the sequence's authored crop rect onto each clip's own real
 * aspect ratio (video_math.ts's reprojectCropRect) instead of reusing it
 * verbatim against a differently-shaped clip -- see that function's own
 * doc comment.
 */
import { getVideoDurationAndDimensions } from "@/lib/video/video";
import { getAudioDuration } from "@/lib/video/audio";
import { loadCrossOriginImage } from "@/lib/crossOriginImage";
import { buildSequenceClipInfos, type SequenceClipInfo, type SequenceEntry } from "@/lib/video/video_math";

export async function gatherSequenceClipInfos(
  clips: (SequenceEntry & { url: string })[]
): Promise<SequenceClipInfo[]> {
  const clipMeta: {
    id: string;
    assetId: string;
    url: string;
    durationSeconds: number;
    kind: "video" | "image";
    width?: number;
    height?: number;
  }[] = [];
  for (const clip of clips) {
    if (clip.kind === "image") {
      // Duration is authored (see lib/video/imageTemplates.ts), not read
      // from anywhere -- but dimensions still need probing, same as a
      // video clip (see this file's own module comment).
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
