"use client";

/**
 * Click-to-open popup for an image ticket attachment -- same hand-rolled
 * modal chrome as editor-v2/AssetPreviewPopup.tsx, simplified: see
 * AttachmentThumbnail.tsx's own comment on why a plain <img src> against
 * the presigned URL is safe here (never re-consumed by CanvasPlayer's
 * CORS-mode compositing, unlike a project Asset).
 */
import type { TicketAttachment } from "@/lib/api";

export function AttachmentPreviewPopup({ attachment, onClose }: { attachment: TicketAttachment; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview: ${attachment.filename}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-lg rounded-lg bg-surface p-4 shadow-lg">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="truncate text-sm font-semibold" title={attachment.filename}>
            {attachment.filename}
          </h3>
          <button type="button" onClick={onClose} aria-label="Close preview" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-md bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element -- a presigned R2 URL; see this component's own module comment */}
          <img src={attachment.url} alt={attachment.filename} className="max-h-[60vh] w-full object-contain" />
        </div>
      </div>
    </div>
  );
}
