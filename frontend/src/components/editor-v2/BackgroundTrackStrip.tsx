"use client";

/**
 * Visualizes the background-music sequence repeating (looping) across the
 * full duration of the video, as a strip of segments -- one per track per
 * loop -- shown above the frame thumbnail strip in the Playground. Empty
 * state when no track is selected.
 *
 * Takes an ordered list of already-resolved tracks ({name, url}[]) rather
 * than a catalog id -- the caller (ThreePaneEditor) is the one that knows
 * whether the background is a curated BACKGROUND_TRACK_OPTIONS entry or
 * one or more of this project's own music assets (appended via
 * AssetGallery's right-click "Add"), so this component doesn't need to
 * know that distinction exists. Multiple tracks concatenate into one
 * combined sequence (fetching each one's own duration sequentially, same
 * SequenceClipInfo/buildSequenceClipInfos/totalSequenceDuration math the
 * video sequence uses -- see video_math.ts), and that whole combined
 * sequence loops across the video's duration, rather than looping just
 * one track.
 *
 * Total width is `videoDurationSeconds * pixelsPerSecond` -- the same scale
 * FrameStrip and MainAudioTrackStrip use, so all three line up and share
 * one scroll position (see lib/useSyncedHorizontalScroll.ts). (Used to also
 * carry its own MusicNoteIcon badge at the rail's left edge for telling the
 * two rails apart at a glance -- dropped once Playground.tsx started
 * overlaying a VolumeBadge on that same corner, which would have sat right
 * on top of it; the two rails' own colors plus their fixed top/bottom order
 * already tell them apart.)
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
  videoDurationSeconds,
  pixelsPerSecond,
  scrollContainerRef,
  onScroll,
}: {
  tracks: { name: string; url: string }[];
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
        return { key: `${loopIndex}-${clipIndex}`, widthFraction, title: `${clip.assetId} -- loop ${loopIndex + 1}` };
      })
      .filter((segment): segment is { key: string; widthFraction: number; title: string } => segment !== null)
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
            className="shrink-0 rounded-sm bg-accent"
          />
        ))}
      </div>
    </div>
  );
}
