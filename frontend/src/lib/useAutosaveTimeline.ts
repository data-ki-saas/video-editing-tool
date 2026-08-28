"use client";

/**
 * Persists an editor's edit-history + cosmetic Timeline fields whenever any
 * of them change, debounced -- and flushes any pending save immediately on
 * unmount rather than silently dropping a change made just before switching
 * reels or navigating away. Extracted out of ThreePaneEditor.tsx (which had
 * this inline) so MobileEditor.tsx can share the exact same save contract --
 * two independent copies of this debounce/flush logic would be an easy way
 * for the two editors' save behavior to quietly drift apart over time.
 */
import { useEffect, useRef, useState } from "react";
import { saveTimeline, type EditHistoryEntrySnapshot, type Timeline, type TimelineMarker } from "@/lib/projects";

const SAVE_DEBOUNCE_MS = 600;

export interface AutosaveTimelineFields {
  projectId: string;
  initialTimeline: Timeline;
  editHistoryEntries: EditHistoryEntrySnapshot[];
  editHistoryIndex: number;
  selectedTemplateId: string | null;
  selectedBackgroundTrackId: string;
  backgroundSequenceAssetIds: string[];
  markers: TimelineMarker[];
  mainAudioVolume: number;
  backgroundVolume: number;
}

export function useAutosaveTimeline(fields: AutosaveTimelineFields): { saveError: string | null } {
  const {
    projectId,
    initialTimeline,
    editHistoryEntries,
    editHistoryIndex,
    selectedTemplateId,
    selectedBackgroundTrackId,
    backgroundSequenceAssetIds,
    markers,
    mainAudioVolume,
    backgroundVolume,
  } = fields;

  const [saveError, setSaveError] = useState<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSaveRef = useRef<() => void>(() => {});
  const hasSkippedInitialSaveRef = useRef(false);

  useEffect(() => {
    if (!hasSkippedInitialSaveRef.current) {
      hasSkippedInitialSaveRef.current = true;
      return;
    }

    const doSave = () => {
      const nextTimeline: Timeline = {
        ...initialTimeline,
        editHistory: editHistoryEntries,
        editHistoryIndex,
        selectedTemplateId,
        selectedBackgroundTrackId,
        backgroundSequenceAssetIds,
        selectedBackgroundAssetId: undefined,
        markers,
        mainAudioVolume,
        backgroundVolume,
      };
      saveTimeline(projectId, nextTimeline)
        .then(() => setSaveError(null))
        .catch((err) => setSaveError(err instanceof Error ? err.message : "Failed to save your changes"));
    };

    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(doSave, SAVE_DEBOUNCE_MS);
    flushSaveRef.current = () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      doSave();
    };

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [
    projectId,
    initialTimeline,
    editHistoryEntries,
    editHistoryIndex,
    selectedTemplateId,
    selectedBackgroundTrackId,
    backgroundSequenceAssetIds,
    markers,
    mainAudioVolume,
    backgroundVolume,
  ]);

  useEffect(() => {
    return () => flushSaveRef.current();
  }, []);

  return { saveError };
}
