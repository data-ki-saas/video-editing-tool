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

/** Standard "repeat" glyph -- two curved arrows forming a loop -- for the
 * loop-playback toggle below the Play/Pause button. Outline, not filled,
 * like every native media player's repeat icon. */
export function LoopIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M17 2l4 4-4 4" />
      <path d="M21 6H8a5 5 0 0 0-5 5v1" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M3 18h13a5 5 0 0 0 5-5v-1" />
    </svg>
  );
}
