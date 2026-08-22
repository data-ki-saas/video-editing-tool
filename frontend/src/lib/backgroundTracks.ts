/**
 * Background/music track choices for a reel's Playground background strip
 * (see components/editor-v2/BackgroundTrackStrip.tsx). Only "None" exists
 * for now -- this repo has no bundled royalty-free audio to offer as
 * starters yet. Add real entries here (id, name, url) once some are
 * sourced; nothing else needs to change to support them, since a track's
 * duration is always determined dynamically (lib/video/audio.ts's
 * getAudioDuration) rather than hardcoded per entry here.
 */
export interface BackgroundTrackOption {
  id: string;
  name: string;
  url: string | null;
}

export const BACKGROUND_TRACK_OPTIONS: BackgroundTrackOption[] = [{ id: "none", name: "None", url: null }];
