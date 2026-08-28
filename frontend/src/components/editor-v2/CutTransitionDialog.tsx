"use client";

/**
 * Popup for picking the cut-transition (or "Cut," i.e. none/hard cut) that
 * plays INTO one specific base-sequence clip from whichever clip precedes
 * it -- opened from FrameStrip's own clip-boundary badge (see that file's
 * own comment on why the badge sits ALONGSIDE, not instead of, an image
 * clip's existing duration-drag handle). Same one-click-applies-and-closes
 * convention as FilterPresetDialog, which this dialog otherwise mirrors
 * closely: a left preview pane (here, a small looping CSS animation of the
 * two real adjacent thumbnails, restyled per whichever option is
 * hovered/focused) and a right options grid.
 *
 * Named "CutTransitionDialog", never bare "TransitionDialog" -- this
 * codebase already has an unrelated, older "transition" concept (the
 * pan/zoom Ken Burns effect) -- see video_math.ts's
 * SequenceEntry.cutTransitionInId doc comment.
 */
import { useEffect, useState } from "react";
import { CUT_TRANSITION_OPTIONS, type CutTransitionId } from "@/lib/video/cutTransitionPresets";

const LOOP_DURATION_MS = 1400;

function CutIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <path d="M8.5 7.5L20 18M8.5 16.5L20 6" />
    </svg>
  );
}
function FadeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16" fill="currentColor" stroke="none" />
    </svg>
  );
}
function SlideIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M3 12h13M11 7l5 5-5 5" />
      <path d="M19 6v12" />
    </svg>
  );
}
function WipeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" className={className}>
      <rect x="3" y="5" width="8" height="14" fill="currentColor" stroke="none" />
      <rect x="3" y="5" width="18" height="14" rx="1" />
    </svg>
  );
}

export function CutTransitionIcon({ id, className }: { id: CutTransitionId | null; className?: string }) {
  switch (id) {
    case "fade":
      return <FadeIcon className={className} />;
    case "slide":
      return <SlideIcon className={className} />;
    case "wipe":
      return <WipeIcon className={className} />;
    default:
      return <CutIcon className={className} />;
  }
}

export function CutTransitionDialog({
  selectedTransitionId,
  onSelect,
  onClose,
  outgoingFrameUrl,
  incomingFrameUrl,
  frameAspectRatio,
}: {
  selectedTransitionId: CutTransitionId | null;
  onSelect: (id: CutTransitionId | null) => void;
  onClose: () => void;
  /** The two real adjacent thumbnails this boundary sits between --
   * FrameStrip already has both cached (the tile just before/after this
   * boundary), so the preview here shows the actual cut, not a placeholder. */
  outgoingFrameUrl: string | null;
  incomingFrameUrl: string | null;
  frameAspectRatio: number | null;
}) {
  const [previewId, setPreviewId] = useState<CutTransitionId | null>(selectedTransitionId);
  // Bumped on an interval to restart the CSS animation below -- a plain CSS
  // transition only fires once per property change, so re-toggling a
  // `data-phase` attribute this way is what makes it LOOP rather than play
  // once and freeze on the incoming frame.
  const [loopPhase, setLoopPhase] = useState(0);

  useEffect(() => {
    if (previewId === null) return; // "Cut" has nothing to animate
    const interval = setInterval(() => setLoopPhase((p) => p + 1), LOOP_DURATION_MS);
    return () => clearInterval(interval);
  }, [previewId]);

  function handleSelect(id: CutTransitionId | null) {
    onSelect(id);
    onClose();
  }

  const isIncomingRevealed = loopPhase % 2 === 0;
  // Wipe: inset() clip-path grows from the right edge to reveal the
  // incoming frame -- an approximation of Creatomate's own WipeLeft
  // geometry (see compileCreatomateTimeline.ts's own disclaimer), matched
  // to CanvasPlayer's identical left-to-right reveal for this preview.
  const incomingStyle: React.CSSProperties =
    previewId === "wipe"
      ? { clipPath: isIncomingRevealed ? "inset(0 0 0 0)" : "inset(0 100% 0 0)", transition: `clip-path ${LOOP_DURATION_MS / 2}ms linear` }
      : previewId === "slide"
        ? { transform: isIncomingRevealed ? "translateX(0)" : "translateX(100%)", transition: `transform ${LOOP_DURATION_MS / 2}ms linear` }
        : previewId === "fade"
          ? { opacity: isIncomingRevealed ? 1 : 0, transition: `opacity ${LOOP_DURATION_MS / 2}ms linear` }
          : { opacity: 1 };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Transition"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Transition</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="mb-3 text-xs text-muted">How this cut plays -- hover an option to preview it first.</p>

        <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
          <div className="flex flex-col gap-1.5 sm:w-1/2">
            <div
              className="relative w-full overflow-hidden rounded-md bg-black"
              style={frameAspectRatio ? { aspectRatio: `${frameAspectRatio}` } : { minHeight: "12rem" }}
            >
              {outgoingFrameUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a thumbnail data URL, not a Next-optimizable static asset
                <img src={outgoingFrameUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
              ) : (
                <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted">No preview yet</p>
              )}
              {incomingFrameUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- a thumbnail data URL, not a Next-optimizable static asset
                <img src={incomingFrameUrl} alt="" className="absolute inset-0 h-full w-full object-cover" style={incomingStyle} />
              )}
            </div>
            <p className="text-[11px] text-muted">{CUT_TRANSITION_OPTIONS.find((o) => o.id === previewId)?.name ?? "Cut"}</p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto sm:w-1/2">
            <div className="grid grid-cols-2 gap-2">
              {[{ id: null as CutTransitionId | null, name: "Cut" }, ...CUT_TRANSITION_OPTIONS].map((option) => {
                const isSelected = option.id === selectedTransitionId;
                return (
                  <button
                    key={option.id ?? "none"}
                    type="button"
                    onMouseEnter={() => setPreviewId(option.id)}
                    onFocus={() => setPreviewId(option.id)}
                    onClick={() => handleSelect(option.id)}
                    title={option.name}
                    className={
                      "flex flex-col items-center justify-center gap-1 rounded-md border-2 p-3 " +
                      (isSelected ? "border-accent bg-accent/10" : "border-transparent hover:bg-background")
                    }
                  >
                    <CutTransitionIcon id={option.id} className="h-6 w-6 text-foreground" />
                    <span className="text-center text-[11px] text-foreground">{option.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
