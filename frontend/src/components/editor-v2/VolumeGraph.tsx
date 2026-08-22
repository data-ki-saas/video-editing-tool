"use client";

/** Renders one bar per audio bucket, produced by lib/video/audio.ts's
 * extractVolumeProfile() (values already normalized 0..1 by
 * lib/video/video_math.ts's computeVolumeBuckets). Purely presentational. */
export function VolumeGraph({ levels, isLoading }: { levels: number[]; isLoading: boolean }) {
  if (levels.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-900 px-2 text-xs text-muted">
        {isLoading ? "Analyzing audio…" : "No audio to display yet"}
      </div>
    );
  }

  const MIN_BAR_HEIGHT_PERCENT = 2; // keeps near-silent buckets visible as a sliver, not invisible

  return (
    <div className="flex h-full items-end gap-px overflow-x-auto bg-neutral-900 px-2 py-1">
      {levels.map((level, index) => (
        <div
          key={index}
          className="w-1 shrink-0 rounded-t-sm bg-accent"
          style={{ height: `${Math.max(MIN_BAR_HEIGHT_PERCENT, level * 100)}%` }}
        />
      ))}
    </div>
  );
}
