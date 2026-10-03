"use client";

/**
 * First-visit walkthrough of the desktop editor: dims the page, spotlights
 * one area at a time (found via its `data-tour="<id>"` attribute -- see
 * TOUR_STEPS below) and shows a short explanation card with Back/Next/Skip.
 * Complements the per-area "?" popovers (HelpTip.tsx): the tour is the
 * "here's the whole layout" pass, the popovers are the "remind me what this
 * one does" pass.
 *
 * Starts itself once per browser (remembered in localStorage, best-effort),
 * and can be replayed any time via startEditorTour(), which the Reels help
 * popup exposes. A step whose anchor isn't on screen (e.g. the export button
 * before any clip exists) is skipped rather than shown pointing at nothing.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const DONE_KEY = "tour:editor:done";
const START_EVENT = "editor-tour:start";
const AUTO_START_DELAY_MS = 1200;
const CARD_WIDTH_PX = 320;
const CARD_ESTIMATED_HEIGHT_PX = 190;
const MARGIN_PX = 12;
const SPOTLIGHT_PADDING_PX = 6;

interface TourStep {
  target: string;
  title: string;
  body: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    target: "reels",
    title: "Your reels",
    body: "Every video you make lives here. We've added a Starter Reel so you can explore with something already in it — use + New when you want a blank one.",
  },
  {
    target: "assets",
    title: "Add your footage",
    body: "Upload clips and photos from your phone with + Asset, grab free footage with + Stock, or reuse saved items with + Library. Right-click any tile to put it into the reel.",
  },
  {
    target: "tools",
    title: "Your toolbox",
    body: "Base tools shape the main video (cutaways, text slides, the cover). Overlays layer extras on top — a second video, captions, a voiceover or an animated character. Not sure where to start? Try the Wizard.",
  },
  {
    target: "preview",
    title: "Preview",
    body: "Watch your reel here as you edit. Everything you add shows up instantly.",
  },
  {
    target: "timeline",
    title: "The timeline",
    body: "Your whole reel laid out left to right. Click to jump to a moment, drag things to move them, and drag their edges to make them shorter or longer.",
  },
  {
    target: "edits",
    title: "Your edits",
    body: "A running list of everything you've changed, newest first, so you can always see what's in your reel.",
  },
  {
    target: "export",
    title: "Save your video",
    body: "When you're happy, press Edge Render to export an MP4 you can post to YouTube or Instagram.",
  },
];

/** Replays the tour from the start -- safe to call from anywhere on the editor page. */
export function startEditorTour() {
  window.dispatchEvent(new Event(START_EVENT));
}

function findTarget(id: string): HTMLElement | null {
  const element = document.querySelector<HTMLElement>(`[data-tour="${id}"]`);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? element : null;
}

function isTourDone(): boolean {
  try {
    return window.localStorage.getItem(DONE_KEY) === "1";
  } catch {
    // Storage blocked -- treat as done so we never nag on every page load.
    return true;
  }
}

function markTourDone() {
  try {
    window.localStorage.setItem(DONE_KEY, "1");
  } catch {
    // Best-effort only.
  }
}

interface Spot {
  rect: DOMRect;
  stepIndex: number;
}

function measure(stepIndex: number): Spot | null {
  const element = findTarget(TOUR_STEPS[stepIndex].target);
  if (!element) return null;
  // The editor scrolls horizontally on narrow windows -- bring the target
  // into view before measuring so the spotlight lands on it.
  element.scrollIntoView({ block: "nearest", inline: "nearest" });
  return { rect: element.getBoundingClientRect(), stepIndex };
}

/** First step at or after `from` (moving in `direction`) whose anchor is on screen. */
function findAvailableStep(from: number, direction: 1 | -1): Spot | null {
  for (let index = from; index >= 0 && index < TOUR_STEPS.length; index += direction) {
    const spot = measure(index);
    if (spot) return spot;
  }
  return null;
}

function cardPosition(rect: DOMRect): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampLeft = (left: number) => Math.max(MARGIN_PX, Math.min(left, vw - CARD_WIDTH_PX - MARGIN_PX));
  const clampTop = (top: number) => Math.max(MARGIN_PX, Math.min(top, vh - CARD_ESTIMATED_HEIGHT_PX - MARGIN_PX));

  if (rect.bottom + MARGIN_PX + CARD_ESTIMATED_HEIGHT_PX <= vh) {
    return { left: clampLeft(rect.left), top: rect.bottom + MARGIN_PX };
  }
  if (rect.top - MARGIN_PX - CARD_ESTIMATED_HEIGHT_PX >= 0) {
    return { left: clampLeft(rect.left), top: rect.top - MARGIN_PX - CARD_ESTIMATED_HEIGHT_PX };
  }
  if (rect.right + MARGIN_PX + CARD_WIDTH_PX <= vw) {
    return { left: rect.right + MARGIN_PX, top: clampTop(rect.top) };
  }
  if (rect.left - MARGIN_PX - CARD_WIDTH_PX >= 0) {
    return { left: rect.left - MARGIN_PX - CARD_WIDTH_PX, top: clampTop(rect.top) };
  }
  // Target fills the viewport -- sit the card inside it, near its top.
  return { left: clampLeft(rect.left + MARGIN_PX), top: clampTop(rect.top + MARGIN_PX) };
}

export function GuidedTour() {
  const [spot, setSpot] = useState<Spot | null>(null);

  // Auto-start once for first-time visitors, after the editor has had a
  // moment to render its panels; also listens for manual replays.
  useEffect(() => {
    function start() {
      setSpot(findAvailableStep(0, 1));
    }
    const timer = isTourDone() ? null : window.setTimeout(start, AUTO_START_DELAY_MS);
    window.addEventListener(START_EVENT, start);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener(START_EVENT, start);
    };
  }, []);

  const stepIndex = spot?.stepIndex ?? null;

  function finish() {
    markTourDone();
    setSpot(null);
  }

  function go(direction: 1 | -1) {
    if (stepIndex === null) return;
    const next = findAvailableStep(stepIndex + direction, direction);
    if (next) setSpot(next);
    else if (direction === 1) finish();
  }

  useEffect(() => {
    if (stepIndex === null) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        markTourDone();
        setSpot(null);
      } else if (event.key === "ArrowRight" || event.key === "Enter") {
        const next = findAvailableStep(stepIndex! + 1, 1);
        if (next) setSpot(next);
        else {
          markTourDone();
          setSpot(null);
        }
      } else if (event.key === "ArrowLeft") {
        const previous = findAvailableStep(stepIndex! - 1, -1);
        if (previous) setSpot(previous);
      }
    }
    // Keep the spotlight on its target if the window is resized mid-tour.
    function handleResize() {
      setSpot(measure(stepIndex!));
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
    };
  }, [stepIndex]);

  if (!spot) return null;

  const step = TOUR_STEPS[spot.stepIndex];
  const hasPrevious = findPreviousExists(spot.stepIndex);
  const isLast = !findNextExists(spot.stepIndex);
  const { rect } = spot;
  const position = cardPosition(rect);

  return createPortal(
    <div className="fixed inset-0 z-[60]">
      {/* Transparent click-catcher so the editor underneath can't be
          interacted with mid-tour. */}
      <div className="absolute inset-0" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute rounded-md ring-2 ring-accent transition-all duration-200"
        style={{
          left: rect.left - SPOTLIGHT_PADDING_PX,
          top: rect.top - SPOTLIGHT_PADDING_PX,
          width: rect.width + SPOTLIGHT_PADDING_PX * 2,
          height: rect.height + SPOTLIGHT_PADDING_PX * 2,
          boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.6)",
        }}
      />
      <div
        role="dialog"
        aria-label={`Tour: ${step.title}`}
        style={{ left: position.left, top: position.top, width: CARD_WIDTH_PX }}
        className="absolute rounded-md border border-border bg-surface p-4 text-foreground shadow-xl"
      >
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted">
          Step {spot.stepIndex + 1} of {TOUR_STEPS.length}
        </p>
        <h2 className="mt-1 text-sm font-semibold">{step.title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">{step.body}</p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <button type="button" onClick={finish} className="text-xs text-muted hover:text-foreground">
            Skip tour
          </button>
          <div className="flex gap-2">
            {hasPrevious && (
              <button
                type="button"
                onClick={() => go(-1)}
                className="rounded-md border border-border px-3 py-1 text-xs hover:bg-background"
              >
                Back
              </button>
            )}
            <button
              type="button"
              autoFocus
              onClick={() => go(1)}
              className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-accent-foreground hover:opacity-90"
            >
              {isLast ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function findPreviousExists(index: number): boolean {
  for (let i = index - 1; i >= 0; i--) if (findTarget(TOUR_STEPS[i].target)) return true;
  return false;
}

function findNextExists(index: number): boolean {
  for (let i = index + 1; i < TOUR_STEPS.length; i++) if (findTarget(TOUR_STEPS[i].target)) return true;
  return false;
}
