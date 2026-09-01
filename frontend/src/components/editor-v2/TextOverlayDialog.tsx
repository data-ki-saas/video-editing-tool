"use client";

/**
 * The "decent editor popup" for text overlays -- a textarea and a visual
 * template gallery, nothing else (no font/color/animation controls; see
 * lib/video/textTemplates.ts for why). Used both for adding a new overlay
 * (editingOverlay is null, defaults to the first template) and for editing
 * an existing one's text/template/position (pre-filled, reopened via
 * TextOverlayTrack's "Edit text" or a plain click on its segment, or via
 * this dialog's own "Already on this reel" list below).
 *
 * Split roughly 50/50: the left half is a live preview of the ACTUAL
 * current video frame (previewFrameUrl -- the thumbnail closest to the
 * playhead, from ThreePaneEditor) with the caption's rect draggable/
 * resizable directly on top of it (OverlayRectOverlay, the same component
 * FrameStrip's active tile uses). Positioning against the real frame at
 * its real width -- rather than only via FrameStrip's much smaller active
 * tile after closing this dialog -- is the actual point: "hard to adjust
 * to the frame width" was the whole complaint this replaces. The right
 * half is the textarea + template gallery, each tile previewing via
 * TextOverlayCanvas -- the SAME renderer CanvasPlayer uses for final
 * playback -- at a fixed mid-way progress (0.6), so entrance animations
 * read as "settled" rather than caught mid-transition.
 *
 * Text no longer just overflows its box: every template in
 * lib/video/textTemplates.ts now wraps and auto-shrinks to fit whatever
 * rect it's given, so dragging the rect narrower/shorter here reshapes the
 * text to match, live, in this same preview.
 *
 * The "Already on this reel" list (same rationale as
 * VideoOverlayPickerDialog.tsx's own) is the only way to switch which
 * caption this dialog is editing without first closing it and hunting for
 * the right segment on TextOverlayTrack -- clicking a row there both jumps
 * the live preview to it AND re-points this same open dialog at it
 * (onSelectExisting), rather than only being reachable pre-open.
 */
import { useEffect, useState } from "react";
import { TEXT_TEMPLATE_OPTIONS, type TextTemplateId } from "@/lib/video/textTemplates";
import { TextOverlayCanvas } from "./TextOverlayCanvas";
import { OverlayRectOverlay } from "./OverlayRectOverlay";
import { DEFAULT_TEXT_OVERLAY_RECT, formatTimeRange, type CropRect, type TextOverlay } from "@/lib/video/video_math";

const PREVIEW_PROGRESS = 0.6;
const DEFAULT_PREVIEW_TEXT = "Your text here";

export function TextOverlayDialog({
  editingOverlay,
  textOverlays,
  previewFrameUrl,
  frameAspectRatio,
  onSave,
  onSelectExisting,
  onClose,
}: {
  editingOverlay: TextOverlay | null;
  // Every text overlay already placed on this reel -- see this file's own
  // module comment for why they're listed here.
  textOverlays: TextOverlay[];
  previewFrameUrl: string | null;
  frameAspectRatio: number | null;
  onSave: (text: string, templateId: TextTemplateId, rect: CropRect) => void;
  // A row's own click, in the "Already on this reel" list -- jumps the
  // live preview there and re-points this same dialog at that overlay.
  onSelectExisting: (overlayIndex: number) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(editingOverlay?.text ?? "");
  const [templateId, setTemplateId] = useState<TextTemplateId>(
    (editingOverlay?.templateId as TextTemplateId) ?? TEXT_TEMPLATE_OPTIONS[0].id
  );
  const [rect, setRect] = useState<CropRect>(editingOverlay?.rect ?? DEFAULT_TEXT_OVERLAY_RECT);

  // Re-syncs if a different overlay is opened for editing (or the dialog
  // is reopened fresh for "Add") while already mounted.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(editingOverlay?.text ?? "");
    setTemplateId((editingOverlay?.templateId as TextTemplateId) ?? TEXT_TEMPLATE_OPTIONS[0].id);
    setRect(editingOverlay?.rect ?? DEFAULT_TEXT_OVERLAY_RECT);
  }, [editingOverlay]);

  function handleSave() {
    if (!text.trim()) return;
    onSave(text, templateId, rect);
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
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{editingOverlay ? "Edit text" : "Add text"}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 sm:flex-row">
          {/* Left half: the real frame, with the caption's rect draggable
              directly on top of it. */}
          <div className="flex flex-col gap-1.5 sm:w-1/2">
            <div
              className="relative w-full overflow-hidden rounded-md bg-black"
              style={frameAspectRatio ? { aspectRatio: `${frameAspectRatio}` } : { minHeight: "12rem" }}
            >
              {previewFrameUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- a thumbnail data URL, not a Next-optimizable static asset
                <img src={previewFrameUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
              ) : (
                <p className="absolute inset-0 flex items-center justify-center p-2 text-center text-xs text-muted">
                  No frame preview yet -- add a video first
                </p>
              )}
              <OverlayRectOverlay
                rect={rect}
                onChange={setRect}
                onCommit={setRect}
                renderInner={
                  <TextOverlayCanvas
                    text={text.trim() || DEFAULT_PREVIEW_TEXT}
                    templateId={templateId}
                    progress={PREVIEW_PROGRESS}
                    className="h-full w-full"
                  />
                }
              />
            </div>
            <p className="text-[11px] text-muted">Drag to position, drag the corner to resize.</p>
          </div>

          {/* Right half: text + template gallery. */}
          <div className="flex min-h-0 flex-1 flex-col sm:w-1/2">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type your caption…"
              rows={2}
              className="mb-3 w-full resize-none rounded-md border border-border bg-background px-2 py-1 text-sm"
            />

            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="grid grid-cols-2 gap-2">
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

            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-border py-1.5 px-3 text-sm font-medium text-foreground hover:bg-background"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!text.trim()}
                className="rounded-md bg-accent py-1.5 px-3 text-sm font-medium text-accent-foreground disabled:opacity-50"
              >
                {editingOverlay ? "Save" : "Add"}
              </button>
            </div>

            {textOverlays.length > 0 && (
              <div className="mt-3 min-h-0 border-t border-border pt-2">
                <h3 className="mb-1 text-xs font-medium text-foreground">Already on this reel</h3>
                <ul className="flex max-h-24 flex-col gap-0.5 overflow-y-auto">
                  {textOverlays.map((overlay, index) => (
                    <li key={index}>
                      <button
                        type="button"
                        onClick={() => onSelectExisting(index)}
                        title="Jump the preview here and edit this caption"
                        className={
                          "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs hover:bg-background " +
                          (overlay === editingOverlay ? "bg-accent/10" : "")
                        }
                      >
                        <span className="min-w-0 flex-1 truncate text-foreground">&quot;{overlay.text}&quot;</span>
                        <span className="shrink-0 text-muted">{formatTimeRange(overlay.startTimeSeconds, overlay.endTimeSeconds)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
