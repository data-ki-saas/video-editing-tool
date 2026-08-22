"use client";

/** Filled, video-player-style Play/Pause glyphs -- for icon-only,
 * transparent-background playback controls (see CanvasPlayer.tsx). Filled
 * rather than outline, matching how every native media player renders
 * these (an outline triangle reads poorly at small sizes). */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function PlayIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}
