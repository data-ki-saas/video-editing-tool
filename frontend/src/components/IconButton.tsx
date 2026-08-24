import { useId } from "react";

// Hand-rolled, dependency-free icon -- consistent with the sibling ../data
// project's IconButton.tsx pattern (straight lines/basic shapes, no icon
// library dependency for a single presentational mark).

// A vertical (9:16) squircle frame with a small camera-notch detail and a
// gradient-filled play triangle -- literally the shape of what this app
// produces, with enough finish to read as a proper app-icon mark rather
// than a single flat outline+triangle. Dual-colour like ../data's
// HomeIcon: the frame is an outline in the current text colour, the play
// mark is filled in the same emerald used for this app's primary actions
// (Render / Create My Reel), so the logo reads as "on-brand" rather than a
// generic play icon.
//
// useId (not a hardcoded id) because this renders more than once on the
// same page (site header + landing hero) -- a fixed gradient id would
// collide across instances and browsers dedupe/misresolve <defs> ids that
// collide. Colons stripped since older Safari mishandles ':' inside a
// url(#...) fragment reference.
export function ReelIcon() {
  const gradientId = `reel-icon-gradient-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <defs>
        <linearGradient id={gradientId} x1="8" y1="7" x2="14" y2="13" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#34d399" />
          <stop offset="1" stopColor="#059669" />
        </linearGradient>
      </defs>
      <rect x="5.5" y="2" width="13" height="20" rx="3.5" stroke="currentColor" strokeWidth="1.75" />
      <rect x="10.5" y="4.3" width="3" height="1.1" rx="0.55" fill="currentColor" opacity="0.45" />
      <path d="M10 9.2v5.6l5-2.8-5-2.8Z" fill={`url(#${gradientId})`} />
    </svg>
  );
}
