// Hand-rolled, dependency-free icon -- consistent with the sibling ../data
// project's IconButton.tsx pattern (straight lines/basic shapes, no icon
// library dependency for a single presentational mark).

// A vertical (9:16) frame with a play triangle -- literally the shape of
// what this app produces. Dual-colour like ../data's HomeIcon: the frame is
// an outline in the current text colour, the play mark is filled in the
// same emerald used for this app's primary actions (Render / Create My
// Reel), so the logo reads as "on-brand" rather than a generic play icon.
export function ReelIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="6" y="2" width="12" height="20" rx="2.5" stroke="currentColor" />
      <path d="M10.3 9.2v5.6l4.6-2.8-4.6-2.8Z" fill="#059669" stroke="#059669" strokeLinejoin="round" />
    </svg>
  );
}
