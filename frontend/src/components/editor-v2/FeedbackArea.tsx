"use client";

/**
 * Bottom band of the three-pane editor. Left: the list of edit changes made
 * so far (template/clip-rectangle/background-track selections -- see
 * lib/useEditHistory.ts), each revertible; the current entry is
 * highlighted and can't be re-selected. Right: status/errors from the
 * asset list and the thumbnail/volume analysis pipeline.
 */
import type { EditHistoryEntry } from "@/lib/useEditHistory";
import type { EditSelectionsSnapshot } from "@/lib/projects";

function ChangeHistoryList({
  entries,
  currentIndex,
  onRevert,
}: {
  entries: EditHistoryEntry<EditSelectionsSnapshot>[];
  currentIndex: number;
  onRevert: (index: number) => void;
}) {
  if (entries.length <= 1) {
    return <p className="text-xs text-muted">No changes yet.</p>;
  }

  return (
    <ul className="flex h-full flex-col gap-0.5 overflow-y-auto">
      {entries.map((entry, index) => (
        <li key={entry.at}>
          <button
            type="button"
            disabled={index === currentIndex}
            onClick={() => onRevert(index)}
            title={index === currentIndex ? "Current" : `Revert to: ${entry.label}`}
            className={
              "flex w-full items-center justify-between gap-2 rounded-md px-2 py-0.5 text-left text-xs " +
              (index === currentIndex
                ? "bg-accent/10 text-foreground"
                : "text-muted hover:bg-background hover:text-foreground")
            }
          >
            <span className="truncate">{entry.label}</span>
            {index !== currentIndex && <span className="shrink-0 text-accent">Revert</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function FeedbackArea({
  assetsError,
  analysisError,
  saveError,
  isAnalyzing,
  isUploading,
  editHistoryEntries,
  editHistoryIndex,
  onRevertEdit,
}: {
  assetsError: string | null;
  analysisError: string | null;
  saveError: string | null;
  isAnalyzing: boolean;
  isUploading: boolean;
  editHistoryEntries: EditHistoryEntry<EditSelectionsSnapshot>[];
  editHistoryIndex: number;
  onRevertEdit: (index: number) => void;
}) {
  const hasMessages = assetsError || analysisError || saveError || isAnalyzing || isUploading;

  return (
    <div className="flex h-full gap-4 px-4 py-2 text-sm">
      <div className="w-64 shrink-0 overflow-hidden border-r border-border pr-4">
        <ChangeHistoryList entries={editHistoryEntries} currentIndex={editHistoryIndex} onRevert={onRevertEdit} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        {!hasMessages && <p className="text-muted">No issues to report.</p>}
        {assetsError && <p className="text-red-600">Couldn&apos;t load your videos: {assetsError}</p>}
        {analysisError && <p className="text-red-600">Couldn&apos;t analyze this video: {analysisError}</p>}
        {saveError && <p className="text-red-600">Couldn&apos;t save your changes: {saveError}</p>}
        {isUploading && <p className="text-muted">Uploading…</p>}
        {isAnalyzing && !analysisError && <p className="text-muted">Analyzing video for the timeline preview…</p>}
      </div>
    </div>
  );
}
