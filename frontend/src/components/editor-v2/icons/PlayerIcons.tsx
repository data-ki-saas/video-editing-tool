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

/** Four outward corner arrows -- "expand to full window," for the preview
 * player's fullscreen toggle. Outline, matching LoopIcon's stroke style. */
export function ExpandIcon(props: IconProps) {
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
      <path d="M8 3H5a2 2 0 0 0-2 2v3" />
      <path d="M16 3h3a2 2 0 0 1 2 2v3" />
      <path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

/** Four inward corner arrows -- the fullscreen toggle's other state, "exit
 * full window." Same stroke style as ExpandIcon. */
export function CollapseIcon(props: IconProps) {
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
      <path d="M9 3v3a2 2 0 0 1-2 2H4" />
      <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
      <path d="M3 16h3a2 2 0 0 1 2 2v3" />
      <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
    </svg>
  );
}

/** A camera body with a shutter dot -- opens the camera Record page
 * (CameraCapturePage.tsx), badged right after CoverIcon's thumbnail button
 * in TopMenuBar since both live in that same "this reel's own media"
 * button group. Outline, matching CoverIcon/RenderIcon's stroke style. */
export function RecordIcon(props: IconProps) {
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
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h9A1.5 1.5 0 0 1 15 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 3 16.5v-9Z" />
      <path d="m15 10 6-3.5v11L15 14" />
      <circle cx="9" cy="12" r="2.25" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Two curved arrows around a camera body -- CameraCapturePage's
 * front/back camera switch button (mobile only, shown when
 * enumerateDevices reports more than one video input). */
export function FlipCameraIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M8 6h2l1.2-1.6h1.6L14 6h2a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" />
      <circle cx="12" cy="12.5" r="2.8" />
      <path d="M4 9a8 8 0 0 1 3-6M20 15a8 8 0 0 1-3 6" />
      <path d="M6.3 1.6 7 3l-1.7.5M17.7 20.4 17 19l1.7-.5" />
    </svg>
  );
}

/** Counter-clockwise refresh arrow -- CameraCapturePage's "Reset" button
 * (discard what's recorded so far and start over), same outline stroke
 * style as ExpandIcon/CollapseIcon. */
export function ResetIcon(props: IconProps) {
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
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

/** Simple picture/image glyph for the cover/thumbnail picker action --
 * outline, matching LocalRenderIcon/RenderIcon's stroke style. */
export function CoverIcon(props: IconProps) {
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
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m4 17 5-5 4 4 3-3 4 4" />
    </svg>
  );
}

/** A page of text lines -- CameraCapturePage's Teleprompter button, which
 * opens the popup where a script is typed in. Outline, matching
 * FlipCameraIcon/ResetIcon's stroke style. */
export function TeleprompterIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="4" y="3" width="16" height="18" rx="1.5" />
      <path d="M7.5 8h9M7.5 11.5h9M7.5 15h5.5" />
    </svg>
  );
}

/** Open eye -- CameraCapturePage's "show teleprompter" state, toggled with
 * EyeOffIcon below. */
export function EyeIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
}

/** Eye with a slash through it -- CameraCapturePage's "teleprompter hidden"
 * state (the script text is kept, just not shown over the preview). */
export function EyeOffIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M3.5 3.5l17 17" />
      <path d="M10.6 5.6A10.6 10.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a15.6 15.6 0 0 1-3.2 3.9M6.7 7.2C4.2 8.9 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9.9 9.9 0 0 0 3.4-.6" />
      <path d="M9.7 9.7a2.75 2.75 0 0 0 3.9 3.9" />
    </svg>
  );
}
