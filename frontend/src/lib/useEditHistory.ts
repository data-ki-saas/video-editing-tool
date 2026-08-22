"use client";

/**
 * Tracks a linear history of edit "snapshots" for some piece of state --
 * generic over T so it isn't tied to any one editor's fields (currently
 * used for the template/clip-rectangle/background-track selections in
 * ThreePaneEditor, but doesn't know anything about them). Reverting to an
 * earlier entry restores its snapshot as the current state and discards
 * every entry after it -- standard undo semantics: diverging from a
 * reverted-to point starts a fresh branch, it doesn't keep the discarded
 * future sitting around waiting to be redone.
 *
 * `entries`/`currentIndex` are also exactly the shape persisted into
 * Timeline.editHistory/editHistoryIndex (see lib/projects.ts) -- pass them
 * back in as `initialEntries`/`initialIndex` to resume a reel's history
 * across sessions instead of starting fresh.
 */
import { useCallback, useState } from "react";

export interface EditHistoryEntry<T> {
  label: string;
  state: T;
  at: number;
}

export interface UseEditHistoryResult<T> {
  state: T;
  entries: EditHistoryEntry<T>[];
  currentIndex: number;
  pushChange: (label: string, nextState: T) => void;
  revertTo: (index: number) => void;
}

export function useEditHistory<T>(
  initialState: T,
  initialEntries?: EditHistoryEntry<T>[],
  initialIndex?: number
): UseEditHistoryResult<T> {
  const [{ entries, currentIndex }, setHistoryState] = useState<{ entries: EditHistoryEntry<T>[]; currentIndex: number }>(
    () => {
      const seededEntries =
        initialEntries && initialEntries.length > 0
          ? initialEntries
          : [{ label: "Initial state", state: initialState, at: Date.now() }];
      const seededIndex = initialIndex !== undefined ? Math.min(Math.max(initialIndex, 0), seededEntries.length - 1) : 0;
      return { entries: seededEntries, currentIndex: seededIndex };
    }
  );

  const pushChange = useCallback((label: string, nextState: T) => {
    setHistoryState((prev) => {
      const truncated = prev.entries.slice(0, prev.currentIndex + 1);
      const nextEntries = [...truncated, { label, state: nextState, at: Date.now() }];
      return { entries: nextEntries, currentIndex: nextEntries.length - 1 };
    });
  }, []);

  const revertTo = useCallback((index: number) => {
    setHistoryState((prev) => ({ ...prev, currentIndex: Math.min(Math.max(index, 0), prev.entries.length - 1) }));
  }, []);

  return { state: entries[currentIndex].state, entries, currentIndex, pushChange, revertTo };
}
