"use client";

/**
 * A small "?" button that opens a short explainer popover -- placed beside
 * the editor's main sections so a first-time creator can learn what each one
 * is for without leaving the page. The popover renders through a portal with
 * fixed positioning (computed from the button's rect when it opens) because
 * nearly every editor panel is overflow-hidden/overflow-auto and would clip a
 * normally-positioned popover.
 *
 * Until a tip has been opened once, its button shows a soft pulsing ring so a
 * new user notices the help exists; "seen" is remembered per tip `id` in
 * localStorage (best-effort -- unavailable storage just means the ring keeps
 * showing). Server render and first client render both report "seen" so
 * hydration never mismatches and no ring flashes for returning users.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

const STORAGE_PREFIX = "helptip:seen:";
const POPOVER_WIDTH_PX = 288;
const VIEWPORT_MARGIN_PX = 8;
// Rough popover height used only to decide whether to open upward when there
// isn't room below -- the real height is whatever the content needs.
const ESTIMATED_HEIGHT_PX = 220;

const seenListeners = new Set<() => void>();

function readSeen(id: string): boolean {
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + id) === "1";
  } catch {
    return false;
  }
}

function markSeen(id: string) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + id, "1");
  } catch {
    // Storage blocked/full -- the pulse just keeps showing.
  }
  seenListeners.forEach((listener) => listener());
}

function subscribeSeen(listener: () => void) {
  seenListeners.add(listener);
  return () => {
    seenListeners.delete(listener);
  };
}

interface PopoverPosition {
  left: number;
  top?: number;
  bottom?: number;
}

export function HelpTip({
  id,
  title,
  children,
  className = "",
}: {
  id: string;
  title: string;
  // A function child receives `close`, for content with its own action
  // button (e.g. "Take the tour") that should dismiss the popover first.
  children: ReactNode | ((close: () => void) => ReactNode);
  className?: string;
}) {
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const isSeen = useSyncExternalStore(
    subscribeSeen,
    () => readSeen(id),
    () => true
  );
  const isOpen = position !== null;

  useEffect(() => {
    if (!isOpen) return;
    const close = () => setPosition(null);
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    // A fixed-position popover would drift away from its button if anything
    // scrolled or the window resized underneath it -- just dismiss instead.
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [isOpen]);

  function handleToggle() {
    if (isOpen) {
      setPosition(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(
      VIEWPORT_MARGIN_PX,
      Math.min(rect.left, window.innerWidth - POPOVER_WIDTH_PX - VIEWPORT_MARGIN_PX)
    );
    const fitsBelow = rect.bottom + 6 + ESTIMATED_HEIGHT_PX <= window.innerHeight;
    setPosition(fitsBelow ? { left, top: rect.bottom + 6 } : { left, bottom: window.innerHeight - rect.top + 6 });
    markSeen(id);
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        aria-label={`Help: ${title}`}
        aria-expanded={isOpen}
        title={`Help: ${title}`}
        className={
          "relative inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-[10px] font-semibold leading-none text-muted hover:text-accent " +
          className
        }
      >
        ?
        {!isSeen && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -inset-1 animate-ping rounded-full border border-accent opacity-60"
          />
        )}
      </button>
      {position &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label={title}
            style={{ left: position.left, top: position.top, bottom: position.bottom, width: POPOVER_WIDTH_PX }}
            className="fixed z-50 rounded-md border border-border bg-surface p-3 text-xs text-foreground shadow-lg"
          >
            <p className="mb-1 text-sm font-medium">{title}</p>
            <div className="flex flex-col gap-1.5 leading-relaxed text-muted">
              {typeof children === "function" ? children(() => setPosition(null)) : children}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
