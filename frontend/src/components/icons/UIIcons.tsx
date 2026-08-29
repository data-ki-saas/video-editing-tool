"use client";

/** Small chrome icons used outside the player/action-button icon sets:
 * SignOutButton's power icon, and CollapsiblePanel headers like Clip
 * rectangle. */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function PowerIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 2v9" />
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
    </svg>
  );
}

// A classic mic capsule on a stand -- badges MainAudioTrackStrip's own left
// edge, distinguishing "the reel's own captured sound" from
// MusicNoteIcon's background-music badge on BackgroundTrackStrip.
export function MicrophoneIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4M9 21h6" />
    </svg>
  );
}

export function MusicNoteIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

// Opens MobileReelMenu's reel-switcher/settings/sign-out drawer -- the
// mobile editor's only entry point to any of that, since it has no
// persistent sidebar (unlike ThreePaneEditor's ProjectList) or (chrome)
// layout (unlike bare /dashboard) to put those controls in otherwise.
export function MenuIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

export function CropToolIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" {...props}>
      <path d="M6 2v14a2 2 0 0 0 2 2h14" />
      <path d="M18 22V8a2 2 0 0 0-2-2H2" />
    </svg>
  );
}

// Two rectangles side by side -- toggling calls the split-screen
// orientation switch (VideoOverlayTrack's own icon button); rotates 90deg
// via CSS when the active layout is vertical instead of needing a second
// icon.
export function SplitScreenOrientationIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="2.5" y="4" width="8" height="16" rx="1.5" />
      <rect x="13.5" y="4" width="8" height="16" rx="1.5" />
    </svg>
  );
}

// A frame with a smaller filled frame inset at its corner -- the
// universal picture-in-picture glyph, badged on a Picture-in-Picture
// VideoOverlayTrack segment the same way SplitScreenOrientationIcon badges
// a Split Screen one.
export function PictureInPictureIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="5" width="18" height="14" rx="1.5" />
      <rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Four corner brackets -- badged on a Full-Screen VideoOverlayTrack
// segment, same convention as PictureInPictureIcon/
// SplitScreenOrientationIcon above.
export function FullScreenIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
    </svg>
  );
}

// Two opposing arrows -- swaps which half a split-screen overlay's footage
// occupies.
export function SwapIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M7 7h13l-3.5-3.5" />
      <path d="M17 17H4l3.5 3.5" />
    </svg>
  );
}

// A viewfinder with a centered crosshair -- opens VideoOverlayTrack's
// framing popup (recenter + flip the overlay's own footage within
// whatever box its layout gives it).
export function FramingIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M12 8v8M8 12h8" />
    </svg>
  );
}

// A small flag on a pole -- opens a VideoOverlayTrack segment's own
// OverlaySourceStartDialog, next to its FramingIcon button.
export function MarkerFlagIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 21V4" />
      <path d="M5 4h13l-3.5 4L18 12H5" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Three volume states badged on every VolumeFader (and VideoOverlayTrack's
// own per-segment volume popup) -- the speaker cone shape is shared, only
// the sound-wave marks change, so a glance at the badge (independent of the
// drag handle's own position) reads as "how loud is this" the same way the
// mute/unmuted/mixed icon convention on a real mixing console does.
const SPEAKER_CONE_PATH = "M4 9v6h4l5 5V4L8 9H4z";

export function SpeakerMutedIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d={SPEAKER_CONE_PATH} fill="currentColor" stroke="none" />
      <path d="M17 9l6 6M23 9l-6 6" />
    </svg>
  );
}

export function SpeakerMixedIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d={SPEAKER_CONE_PATH} fill="currentColor" stroke="none" />
      <path d="M15.5 8.5a5 5 0 010 7" />
    </svg>
  );
}

export function SpeakerFullIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d={SPEAKER_CONE_PATH} fill="currentColor" stroke="none" />
      <path d="M15.5 8.5a5 5 0 010 7" />
      <path d="M18.5 5.5a9 9 0 010 13" />
    </svg>
  );
}

// Two arrows either side of a vertical divider -- VideoOverlayFramingDialog's
// "Flip" (horizontal) toggle button.
export function FlipHorizontalIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 3v18" strokeDasharray="2 2" />
      <path d="M7 8l-3 4 3 4" />
      <path d="M17 8l3 4-3 4" />
    </svg>
  );
}

// Same idea, rotated -- VideoOverlayFramingDialog's "Mirror" (vertical)
// toggle button.
export function FlipVerticalIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 12h18" strokeDasharray="2 2" />
      <path d="M8 7l4-3 4 3" />
      <path d="M8 17l4 3 4-3" />
    </svg>
  );
}

// A circular arrow -- ProjectList's "Reset" button, beside its Delete
// (TrashIcon) button.
export function ResetIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 4v6h6" />
      <path d="M4.5 15a8 8 0 1 0 2-8.5L4 10" />
    </svg>
  );
}

// Open scissor blades -- badges TrimTrack's own left edge, marking it as
// "the rail that cuts" alongside its red trimmed-segment fill.
export function ScissorsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M8.5 8.5 20 20" />
      <path d="M20 4 8.5 15.5" />
    </svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
    </svg>
  );
}
