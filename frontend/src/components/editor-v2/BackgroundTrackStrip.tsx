"use client";

/**
 * Visualizes the background-music sequence repeating (looping) across the
 * full duration of the video, as a strip of segments -- one per track per
 * loop -- shown above the frame thumbnail strip in the Playground. Empty
 * state when no track is selected.
 *
 * Takes an ordered list of already-resolved tracks ({assetId, name, url}[])
 * rather than a catalog id -- the caller (ThreePaneEditor) is the one that
 * knows whether the background is a curated BACKGROUND_TRACK_OPTIONS entry
 * (assetId null) or one or more of this project's own music assets
 * (appended via AssetGallery's right-click "Add"), so this component
 * doesn't need to know that distinction exists. Multiple tracks
 * concatenate into one combined sequence (fetching each one's own duration
 * sequentially, same SequenceClipInfo/buildSequenceClipInfos/
 * totalSequenceDuration math the video sequence uses -- see video_math.ts),
 * and that whole combined sequence loops across the video's duration,
 * rather than looping just one track.
 *
 * Add always appends rather than replacing (a single track is almost
 * always already longer than the whole reel, so this is the only way to
 * layer more than one on purpose) -- each track's own name and a remove
 * button are shown directly on its first-loop segment (see `onRemoveTrack`
 * below), since that's the only way to actually swap to different music
 * short of deleting the underlying asset outright.
 *
 * Total width is `videoDurationSeconds * pixelsPerSecond` -- the same scale
 * FrameStrip and MainAudioTrackStrip use, so all three line up and share
 * one scroll position (see lib/useSyncedHorizontalScroll.ts). (This rail
 * doesn't render its own MusicNoteIcon badge -- Playground.tsx overlays
 * one, followed by the VolumeBadge, on this rail's left edge; see that
 * file's own module comment.)
 *
 * `hide-scrollbar`, same as FrameStrip/MainAudioTrackStrip -- a native
 * scrollbar here ate into this rail's own fixed AUDIO_RAIL_HEIGHT_PX height
 * (Playground.tsx), squeezing it shorter than every other rail.
 * Playground.tsx's own proxy scrollbar row, at the very bottom of the whole
 * synced group (below both audio rails), is the one discoverable,
 * draggable affordance for the group -- dragging it (or a trackpad/wheel
 * gesture over any of the three strips) scrolls this rail too.
 */
import { useEffect, useState } from "react";
import { getAudioDuration } from "@/lib/video/audio";
import { buildSequenceClipInfos, totalSequenceDuration, type SequenceClipInfo } from "@/lib/video/video_math";

export function BackgroundTrackStrip({
  tracks,
  onRemoveTrack,
  videoDurationSeconds,
  pixelsPerSecond,
  scrollContainerRef,
  onScroll,
}: {
  tracks: { assetId: string | null; name: string; url: string }[];
  // Undefined `assetId` (a curated-catalog track, not one of this
  // project's own assets) has nothing to remove here -- see this file's
  // own comment on why every real track today always has one anyway.
  onRemoveTrack: (assetId: string) => void;
  videoDurationSeconds: number;
  pixelsPerSecond: number;
  scrollContainerRef: (el: HTMLDivElement | null) => void;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
}) {
  const [sequenceClips, setSequenceClips] = useState<SequenceClipInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Joined URLs, not the `tracks` array reference -- so an unrelated
  // parent re-render doesn't re-fetch every track's duration again.
  const tracksKey = tracks.map((track) => track.url).join(",");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    setSequenceClips([]);
    if (tracks.length === 0) return;

    let cancelled = false;
    setIsLoading(true);

    async function loadDurations() {
      const clipMeta: { assetId: string; url: string; durationSeconds: number }[] = [];
      for (const track of tracks) {
        if (cancelled) return;
        try {
          const duration = await getAudioDuration(track.url);
          clipMeta.push({ assetId: track.name, url: track.url, durationSeconds: duration });
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load a background track");
        }
      }
      if (!cancelled) setSequenceClips(buildSequenceClipInfos(clipMeta));
    }

    loadDurations().finally(() => {
      if (!cancelled) setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on tracksKey (joined urls), not the tracks array reference
  }, [tracksKey]);

  if (tracks.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 px-2 text-xs text-muted">
        No background track selected
      </div>
    );
  }
  if (error && sequenceClips.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 px-2 text-xs text-red-400">{error}</div>
    );
  }

  const sequenceDurationSeconds = totalSequenceDuration(sequenceClips);
  if (isLoading || sequenceDurationSeconds <= 0 || videoDurationSeconds <= 0) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 px-2 text-xs text-muted">Loading…</div>
    );
  }

  // clip.assetId here is actually each track's NAME (see clipMeta above --
  // buildSequenceClipInfos has no separate "display name" field, and the
  // name is unique enough for its own tooltip purpose) -- this recovers the
  // REAL asset id for the remove button, keyed by name rather than
  // position, since a track that failed its duration probe is skipped
  // entirely from clipMeta/sequenceClips, which would desync a
  // position-based lookup against the original `tracks` array.
  const realAssetIdByName = new Map(
    tracks.filter((track): track is { assetId: string; name: string; url: string } => Boolean(track.assetId)).map((track) => [track.name, track.assetId])
  );

  const loopCount = Math.max(1, Math.ceil(videoDurationSeconds / sequenceDurationSeconds));
  const segments = Array.from({ length: loopCount }, (_, loopIndex) => loopIndex).flatMap((loopIndex) =>
    sequenceClips
      .map((clip, clipIndex) => {
        const absoluteStartSeconds = loopIndex * sequenceDurationSeconds + clip.startTimeSeconds;
        if (absoluteStartSeconds >= videoDurationSeconds) return null;
        // The final segment is usually cut short by the video ending
        // mid-track -- it shrinks proportionally instead of overhanging
        // past the strip's right edge.
        const remainingSeconds = videoDurationSeconds - absoluteStartSeconds;
        const widthFraction = Math.min(clip.durationSeconds, remainingSeconds) / videoDurationSeconds;
        return {
          key: `${loopIndex}-${clipIndex}`,
          widthFraction,
          name: clip.assetId,
          title: `${clip.assetId} -- loop ${loopIndex + 1}`,
          // Only the first loop shows the name/remove button -- every later
          // repetition is the same track, and repeating the control on each
          // one would just clutter the rail with duplicate delete buttons
          // for the exact same track.
          removableAssetId: loopIndex === 0 ? realAssetIdByName.get(clip.assetId) : undefined,
        };
      })
      .filter(
        (
          segment
        ): segment is { key: string; widthFraction: number; name: string; title: string; removableAssetId: string | undefined } =>
          segment !== null
      )
  );

  return (
    <div
      ref={scrollContainerRef}
      onScroll={onScroll}
      className="hide-scrollbar h-full overflow-x-auto bg-neutral-950 px-2"
    >
      <div className="relative flex h-full gap-px" style={{ width: videoDurationSeconds * pixelsPerSecond }}>
        {segments.map((segment) => (
          <div
            key={segment.key}
            style={{ flexBasis: `${segment.widthFraction * 100}%` }}
            title={segment.title}
            // Solid fill (not a translucent tint) -- the previous
            // bg-accent/20 + border-accent/40 nearly vanished against
            // neutral-950 for every color theme's accent, light or dark.
            // `gap-px` on the parent (bg-neutral-950 showing through)
            // already separates adjacent segments -- no border needed.
            className="flex shrink-0 items-center justify-between gap-1 overflow-hidden rounded-sm bg-accent pl-1.5"
          >
            {segment.removableAssetId && (
              <>
                <span className="truncate text-[10px] leading-none text-accent-foreground">{segment.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveTrack(segment.removableAssetId!)}
                  aria-label={`Remove ${segment.name} from background music`}
                  title="Remove"
                  className="shrink-0 rounded-sm px-1 py-0.5 text-[10px] leading-none text-accent-foreground hover:bg-black/20"
                >
                  ✕
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
