"use client";

/**
 * "Box" for picking a background/music track for the reel, right after the
 * asset gallery in the Action Area. The chosen track is visualized as a
 * repeating strip above the frame thumbnails in the Playground (see
 * BackgroundTrackStrip.tsx). Catalogue lives in lib/backgroundTracks.ts --
 * currently just "None", since this repo has no bundled starter tracks yet.
 */
import { BACKGROUND_TRACK_OPTIONS } from "@/lib/backgroundTracks";

export function BackgroundTrackSelector({
  selectedTrackId,
  onSelectTrack,
}: {
  selectedTrackId: string;
  onSelectTrack: (id: string) => void;
}) {
  return (
    <div className="flex h-full flex-col gap-2">
      <h2 className="text-sm font-medium text-foreground">Background track</h2>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
        {BACKGROUND_TRACK_OPTIONS.map((track) => (
          <button
            key={track.id}
            type="button"
            onClick={() => onSelectTrack(track.id)}
            className={
              "truncate rounded-md px-2 py-1 text-left text-sm " +
              (track.id === selectedTrackId
                ? "bg-accent text-accent-foreground"
                : "text-foreground hover:bg-background")
            }
          >
            {track.name}
          </button>
        ))}
      </div>

      <p className="text-[10px] text-muted">No starter tracks bundled yet.</p>
    </div>
  );
}
