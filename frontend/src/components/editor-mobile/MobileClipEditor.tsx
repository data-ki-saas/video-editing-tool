"use client";

/**
 * Bottom-sheet action menu for one sequence clip -- opened by tapping a
 * clip row in MobileAssetStrip. Deliberately just a menu, not the dialogs
 * themselves: each action opens its own dialog (ClipRectangleDialog-style
 * reuse for color filter/transition, MobileImageTemplatePicker for motion),
 * owned by MobileEditor the same way ThreePaneEditor owns its own per-clip
 * dialog targets (filterDialogCutaway, transitionDialogEntry, etc.).
 */
export function MobileClipEditor({
  isFirstClip,
  isImageClip,
  onPickMotion,
  onPickFilter,
  onPickTransition,
  onRemove,
  onClose,
}: {
  isFirstClip: boolean;
  isImageClip: boolean;
  onPickMotion: () => void;
  onPickFilter: () => void;
  onPickTransition: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Clip options"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="flex w-full flex-col gap-1 rounded-t-lg bg-surface p-2 pb-4 shadow-lg">
        {isImageClip && (
          <button
            type="button"
            onClick={onPickMotion}
            className="rounded-md px-3 py-3 text-left text-sm text-foreground hover:bg-background"
          >
            Motion
          </button>
        )}
        <button
          type="button"
          onClick={onPickFilter}
          className="rounded-md px-3 py-3 text-left text-sm text-foreground hover:bg-background"
        >
          Color filter
        </button>
        {!isFirstClip && (
          <button
            type="button"
            onClick={onPickTransition}
            className="rounded-md px-3 py-3 text-left text-sm text-foreground hover:bg-background"
          >
            Transition in
          </button>
        )}
        <button type="button" onClick={onRemove} className="rounded-md px-3 py-3 text-left text-sm text-red-600 hover:bg-red-600/10">
          Remove clip
        </button>
        <button
          type="button"
          onClick={onClose}
          className="mt-1 rounded-md border border-border px-3 py-2.5 text-center text-sm font-medium text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
