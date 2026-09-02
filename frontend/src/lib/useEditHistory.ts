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

// Every entry is a FULL copy of the editor's state (see EditSelectionsSnapshot
// in lib/projects.ts), and useAutosaveTimeline re-uploads the WHOLE array on
// every debounced save -- left uncapped, a long editing session's history
// grows without bound until the save payload gets big enough to blow past
// the save client's own timeout (see lib/supabase/client.ts's
// fetchWithTimeout) and every autosave starts failing with a plain
// TimeoutError. Capped at a depth generous enough that no normal editing
// session should ever notice it (most editors cap undo somewhere in the
// 30-100 range) while bounding the worst case.
const MAX_HISTORY_ENTRIES = 50;

export interface EditHistoryEntry<T> {
  label: string;
  state: T;
  at: number;
}

/** Drops the OLDEST entries once `entries` exceeds MAX_HISTORY_ENTRIES,
 * shifting `index` down by the same count so it keeps pointing at the same
 * logical entry -- shared by the initial-seed path (a previously-saved,
 * already-bloated timeline) and pushChange (growing live) so both self-heal
 * to the same cap rather than only capping one of the two. */
function capHistory<T>(entries: EditHistoryEntry<T>[], index: number): { entries: EditHistoryEntry<T>[]; index: number } {
  if (entries.length <= MAX_HISTORY_ENTRIES) return { entries, index };
  const overflow = entries.length - MAX_HISTORY_ENTRIES;
  return { entries: entries.slice(overflow), index: Math.max(0, index - overflow) };
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
      // Caps even on load -- a timeline saved before this cap existed (or
      // from a session that hit it before the next autosave could shrink
      // it) could already be oversized; trimming here means the very next
      // autosave persists the smaller, capped set instead of perpetuating
      // the bloat.
      const capped = capHistory(seededEntries, seededIndex);
      return { entries: capped.entries, currentIndex: capped.index };
    }
  );

  const pushChange = useCallback((label: string, nextState: T) => {
    setHistoryState((prev) => {
      const truncated = prev.entries.slice(0, prev.currentIndex + 1);
      const nextEntries = [...truncated, { label, state: nextState, at: Date.now() }];
      const capped = capHistory(nextEntries, nextEntries.length - 1);
      return { entries: capped.entries, currentIndex: capped.index };
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
