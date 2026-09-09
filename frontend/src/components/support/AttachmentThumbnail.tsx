"use client";

/**
 * One already-uploaded ticket attachment (a real presigned R2 URL) -- click
 * opens a full-size popup for an image, or opens the file in a new tab for
 * a PDF (no in-app PDF viewer for this POC). Unlike
 * editor-v2/AssetPreviewPopup.tsx's Asset, a ticket attachment is never fed
 * into CanvasPlayer's CORS-mode canvas compositing, so a plain <img src>
 * against the presigned URL is fine here -- no useCrossOriginImageSrc
 * blob-URL indirection needed.
 */
import { useState } from "react";
import type { TicketAttachment } from "@/lib/api";
import { FileIcon } from "@/components/icons/UIIcons";
import { AttachmentPreviewPopup } from "./AttachmentPreviewPopup";

export function AttachmentThumbnail({ attachment }: { attachment: TicketAttachment }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const isImage = attachment.mimeType.startsWith("image/");

  function handleClick() {
    if (isImage) {
      setPreviewOpen(true);
    } else {
      window.open(attachment.url, "_blank", "noopener,noreferrer");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        title={attachment.filename}
        className="h-16 w-16 overflow-hidden rounded-md border border-border bg-surface hover:opacity-80"
      >
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- a presigned R2 URL, never fed into CanvasPlayer's CORS-mode compositing (see module comment)
          <img src={attachment.url} alt={attachment.filename} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 p-1 text-muted">
            <FileIcon className="h-5 w-5" />
            <span className="line-clamp-2 break-all text-center text-[9px]">{attachment.filename}</span>
          </div>
        )}
      </button>
      {previewOpen && <AttachmentPreviewPopup attachment={attachment} onClose={() => setPreviewOpen(false)} />}
    </>
  );
}
