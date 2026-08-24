"use client";

/**
 * The auto-caption analog of TextOverlayDialog.tsx -- same 50/50 layout
 * (real current frame + draggable rect on the left, style gallery on the
 * right), but no textarea: there's no text to type, it comes from the
 * video's own spoken audio at render time (Creatomate's own transcription
 * -- see video_math.ts's TranscriptCaption and
 * lib/video/transcriptCaptionTemplates.ts). Every style preview
 * (TranscriptCaptionCanvas) draws the same fixed placeholder phrase, not
 * real words -- there's nothing to transcribe until an actual render runs.
 *
 * One config for the whole video, not a per-instance list: `transcriptCaption`
 * is null (disabled) or set (enabled, with a style + position). The footer
 * reads "Enable" when disabled, "Update" once already enabled, alongside a
 * "Disable" button that only appears when there's something to turn off.
 */
import { useEffect, useState } from "react";
import { TRANSCRIPT_CAPTION_TEMPLATE_OPTIONS, type TranscriptCaptionTemplateId } from "@/lib/video/transcriptCaptionTemplates";
import { TranscriptCaptionCanvas } from "./TranscriptCaptionCanvas";
import { OverlayRectOverlay } from "./OverlayRectOverlay";
import { DEFAULT_TRANSCRIPT_CAPTION_RECT, type CropRect, type TranscriptCaption } from "@/lib/video/video_math";

export function TranscriptCaptionDialog({
  transcriptCaption,
  previewFrameUrl,
  frameAspectRatio,
  onSave,
  onDisable,
  onClose,
}: {
  transcriptCaption: TranscriptCaption | null;
  previewFrameUrl: string | null;
  frameAspectRatio: number | null;
  onSave: (templateId: TranscriptCaptionTemplateId, rect: CropRect) => void;
  onDisable: () => void;
  onClose: () => void;
}) {
  const [templateId, setTemplateId] = useState<TranscriptCaptionTemplateId>(
    (transcriptCaption?.templateId as TranscriptCaptionTemplateId) ?? TRANSCRIPT_CAPTION_TEMPLATE_OPTIONS[0].id
  );
  const [rect, setRect] = useState<CropRect>(transcriptCaption?.rect ?? DEFAULT_TRANSCRIPT_CAPTION_RECT);

  // Re-syncs if enabled/disabled or edited elsewhere while already mounted.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTemplateId((transcriptCaption?.templateId as TranscriptCaptionTemplateId) ?? TRANSCRIPT_CAPTION_TEMPLATE_OPTIONS[0].id);
    setRect(transcriptCaption?.rect ?? DEFAULT_TRANSCRIPT_CAPTION_RECT);
  }, [transcriptCaption]);

  const isEnabled = transcriptCaption !== null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Auto-captions"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Auto-captions</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="mb-3 text-xs text-muted">
          Captions are generated automatically from your video&apos;s spoken audio when you render -- the preview below
          shows placeholder text so you can judge style and position ahead of time.
        </p>

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
                renderInner={<TranscriptCaptionCanvas templateId={templateId} className="h-full w-full" />}
              />
            </div>
            <p className="text-[11px] text-muted">Drag to position, drag the corner to resize.</p>
          </div>

          {/* Right half: style gallery -- no textarea, there's nothing to type. */}
          <div className="flex min-h-0 flex-1 flex-col sm:w-1/2">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="grid grid-cols-2 gap-2">
                {TRANSCRIPT_CAPTION_TEMPLATE_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setTemplateId(option.id)}
                    className={
                      "flex flex-col overflow-hidden rounded-md border-2 " +
                      (templateId === option.id ? "border-accent" : "border-transparent")
                    }
                  >
                    <TranscriptCaptionCanvas templateId={option.id} className="aspect-video w-full bg-neutral-900" />
                    <span className="bg-background px-1 py-0.5 text-center text-[10px] text-foreground">{option.name}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-3 flex gap-2">
              {isEnabled && (
                <button
                  type="button"
                  onClick={onDisable}
                  className="rounded-md border border-red-600 py-1.5 px-3 text-sm font-medium text-red-600 hover:bg-red-600/10"
                >
                  Disable
                </button>
              )}
              <button
                type="button"
                onClick={() => onSave(templateId, rect)}
                className="flex-1 rounded-md bg-accent py-1.5 text-sm font-medium text-accent-foreground"
              >
                {isEnabled ? "Update" : "Enable"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
