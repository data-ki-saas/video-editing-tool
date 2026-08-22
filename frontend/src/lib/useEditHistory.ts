"use client";

/**
 * Tracks a linear history of edit "snapshots" for some piece of state --
 * generic over T so it isn't tied to any one editor's fields (currently
 * used for the clip-rectangle/crop-rect/zoom-effect selections in
 * ThreePaneEditor, but doesn't know anything about them).
 *
 * `revertTo`/`undo`/`redo` just move a pointer over `entries` -- they never
 * discard anything, so redoing after an undo works. Only `pushChange`
 * truncates: making a new change while `currentIndex` isn't at the tip
 * drops every entry after it first, standard undo/redo-stack semantics
 * (the same as a text editor's undo history -- undo/redo freely, but
 * typing something new after undoing starts a fresh branch instead of
 * keeping the discarded future around).
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
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
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

  const undo = useCallback(() => revertTo(currentIndex - 1), [revertTo, currentIndex]);
  const redo = useCallback(() => revertTo(currentIndex + 1), [revertTo, currentIndex]);

  return {
    state: entries[currentIndex].state,
    entries,
    currentIndex,
    pushChange,
    revertTo,
    undo,
    redo,
    canUndo: currentIndex > 0,
    canRedo: currentIndex < entries.length - 1,
  };
}
