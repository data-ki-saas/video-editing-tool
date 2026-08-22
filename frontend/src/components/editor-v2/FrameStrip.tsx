"use client";

/** Renders the video "unfolded" into one thumbnail per second, produced by
 * lib/video/video.ts's extractThumbnails(). Purely presentational -- no
 * extraction or math logic lives here. */
export function FrameStrip({ thumbnails, isLoading }: { thumbnails: string[]; isLoading: boolean }) {
  if (thumbnails.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 px-2 text-xs text-muted">
        {isLoading ? "Generating thumbnails…" : "Select a video to see its timeline"}
      </div>
    );
  }

  return (
    <div className="flex h-full items-center gap-1 overflow-x-auto bg-neutral-950 px-2">
      {thumbnails.map((src, index) => (
        // Index is a stable key here -- one thumbnail per second, always
        // re-derived in full whenever the selected asset changes (see
        // ThreePaneEditor's analysis effect), never reordered in place.
        // eslint-disable-next-line @next/next/no-img-element -- short-lived data: URLs, not a Next-optimizable remote image
        <img key={index} src={src} alt={`Frame at ${index}s`} className="h-full w-auto shrink-0 rounded-sm object-cover" />
      ))}
    </div>
  );
}
