"use client";

/**
 * The "decent editor popup" for text overlays -- a textarea and a visual
 * template gallery, nothing else (no font/color/animation controls; see
 * lib/video/textTemplates.ts for why). Used both for adding a new overlay
 * (editingOverlay is null, defaults to the first template) and for editing
 * an existing one's text/template (pre-filled, reopened via
 * TextOverlayTrack's "Edit text"). Modal chrome matches UploadDialog/
 * StockMediaDialog's established pattern.
 *
 * Each template's gallery tile previews via TextOverlayCanvas -- the SAME
 * renderer CanvasPlayer uses for final playback -- at a fixed mid-way
 * progress (0.6), so entrance animations read as "settled" rather than
 * caught mid-transition.
 */
import { useEffect, useState } from "react";
import { TEXT_TEMPLATE_OPTIONS, type TextTemplateId } from "@/lib/video/textTemplates";
import { TextOverlayCanvas } from "./TextOverlayCanvas";
import type { TextOverlay } from "@/lib/video/video_math";

const PREVIEW_PROGRESS = 0.6;
const DEFAULT_PREVIEW_TEXT = "Your text here";

export function TextOverlayDialog({
  editingOverlay,
  onSave,
  onClose,
}: {
  editingOverlay: TextOverlay | null;
  onSave: (text: string, templateId: TextTemplateId) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(editingOverlay?.text ?? "");
  const [templateId, setTemplateId] = useState<TextTemplateId>(
    (editingOverlay?.templateId as TextTemplateId) ?? TEXT_TEMPLATE_OPTIONS[0].id
  );

  // Re-syncs if a different overlay is opened for editing (or the dialog
  // is reopened fresh for "Add") while already mounted.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(editingOverlay?.text ?? "");
    setTemplateId((editingOverlay?.templateId as TextTemplateId) ?? TEXT_TEMPLATE_OPTIONS[0].id);
  }, [editingOverlay]);

  function handleSave() {
    if (!text.trim()) return;
    onSave(text, templateId);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={editingOverlay ? "Edit text" : "Add text"}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{editingOverlay ? "Edit text" : "Add text"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type your caption…"
          rows={2}
          className="mb-3 w-full resize-none rounded-md border border-border bg-background px-2 py-1 text-sm"
        />

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-3 gap-2">
            {TEXT_TEMPLATE_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setTemplateId(option.id)}
                className={
                  "flex flex-col overflow-hidden rounded-md border-2 " +
                  (templateId === option.id ? "border-accent" : "border-transparent")
                }
              >
                <TextOverlayCanvas
                  text={text.trim() || DEFAULT_PREVIEW_TEXT}
                  templateId={option.id}
                  progress={PREVIEW_PROGRESS}
                  className="aspect-video w-full bg-neutral-900"
                />
                <span className="bg-background px-1 py-0.5 text-center text-[10px] text-foreground">{option.name}</span>
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={!text.trim()}
          className="mt-3 w-full rounded-md bg-accent py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {editingOverlay ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}
