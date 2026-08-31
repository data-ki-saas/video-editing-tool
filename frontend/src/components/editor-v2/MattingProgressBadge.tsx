"use client";

/**
 * Small circular badge showing an AI background-removal job's ESTIMATED
 * progress (see lib/backgroundRemoval.ts's own comment on why this is an
 * estimate, never a real percentage from the provider -- fal.ai's VEED
 * integration is webhook-only, with no interim status it actually reports).
 * Shared between CutawayTrack's and VideoOverlayTrack's own segment badges
 * so both rails read the same way while a matting job is in flight.
 */
export function MattingProgressBadge({ progress }: { progress: number }) {
  const clamped = Math.min(Math.max(progress, 0), 1);
  const radius = 9;
  const circumference = 2 * Math.PI * radius;

  return (
    <span
      title={`Removing background… ${Math.round(clamped * 100)}%`}
      className="pointer-events-none z-10 flex h-3 w-3 shrink-0 items-center justify-center rounded-full bg-black/30 text-white"
    >
      <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 -rotate-90">
        <circle cx="12" cy="12" r={radius} fill="none" stroke="currentColor" strokeOpacity={0.3} strokeWidth={3} />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
        />
      </svg>
    </span>
  );
}
