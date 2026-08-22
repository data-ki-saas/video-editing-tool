"use client";

/**
 * Keeps N scrollable elements' horizontal scroll position in sync --
 * scrolling any one moves all the others to match. Used by Playground.tsx
 * to keep the background-track strip, frame strip, and volume graph
 * visually aligned to the same point in time, since all three represent
 * the same timeline at the same pixels-per-second scale (see its
 * PIXELS_PER_SECOND constant) and are meant to read as one aligned view,
 * not three independently-scrolling panels that happen to be stacked.
 */
import { useCallback, useRef } from "react";

export function useSyncedHorizontalScroll(count: number) {
  const elementsRef = useRef<Array<HTMLDivElement | null>>(Array(count).fill(null));
  // Guards against the scrollLeft assignments below re-triggering this
  // same handler on the elements they update, which would otherwise
  // recurse through all N elements on every scroll event.
  const isSyncingRef = useRef(false);

  const bindRef = useCallback(
    (index: number) => (el: HTMLDivElement | null) => {
      elementsRef.current[index] = el;
    },
    []
  );

  const bindOnScroll = useCallback(
    (index: number) => (e: React.UIEvent<HTMLDivElement>) => {
      if (isSyncingRef.current) return;
      isSyncingRef.current = true;
      const scrollLeft = e.currentTarget.scrollLeft;
      elementsRef.current.forEach((el, i) => {
        if (i !== index && el) el.scrollLeft = scrollLeft;
      });
      isSyncingRef.current = false;
    },
    []
  );

  return { bindRef, bindOnScroll };
}
