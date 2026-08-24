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

/** Simple clapperboard glyph for the Render action -- outline, matching
 * LoopIcon's stroke style. */
export function RenderIcon(props: IconProps) {
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
      <path d="M3 8.5V19a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8.5H3Z" />
      <path d="m3 8.5 1.5-4.5h3L6 8.5" />
      <path d="m9.5 8.5 1.5-4.5h3l-1.5 4.5" />
      <path d="M16 8.5 17.5 4H20a1 1 0 0 1 1 1v3.5" />
    </svg>
  );
}

/** Simple monitor glyph for the free/local render action -- "renders on
 * this device," visually distinct from RenderIcon's clapperboard (which
 * reads as the cloud/studio render), same outline stroke style. */
export function LocalRenderIcon(props: IconProps) {
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
      <rect x="3" y="4" width="18" height="12" rx="1" />
      <path d="M8 20h8" />
      <path d="M12 16v4" />
    </svg>
  );
}
