"use client";

/**
 * A small spinning film-reel animation with a stage label, used wherever
 * the editor is waiting on something (project load, asset list, frame
 * extraction) instead of a bare "Loading…" line with no sense of progress.
 */
export function ReelLoader({ stage, className }: { stage: string; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-3 text-sm text-muted ${className ?? "p-6"}`}>
      <svg viewBox="0 0 24 24" className="h-10 w-10 animate-spin text-accent" fill="none" stroke="currentColor" strokeWidth={1.5}>
        <circle cx="12" cy="12" r="9" />
        <circle cx="12" cy="12" r="2.2" />
        <circle cx="12" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="16.8" cy="14.8" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="7.2" cy="14.8" r="1.4" fill="currentColor" stroke="none" />
      </svg>
      <span>{stage}</span>
    </div>
  );
}
