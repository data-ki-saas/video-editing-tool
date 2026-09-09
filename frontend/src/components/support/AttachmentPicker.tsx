"use client";

/**
 * Multi-file picker for filing/replying to a support ticket -- enforces the
 * same 5-file / 2MB-each limits backend/src/tickets/service.py does
 * server-side (MAX_ATTACHMENTS/MAX_ATTACHMENT_SIZE_BYTES), just earlier so a
 * user finds out before waiting on an upload. Shows a thumbnail preview
 * strip for files already picked but not yet submitted -- a real image
 * preview via URL.createObjectURL, a generic file glyph for a PDF (there's
 * no cheap client-side PDF thumbnail without a rendering library).
 */
import { useRef } from "react";
import { FileIcon } from "@/components/icons/UIIcons";

export const MAX_TICKET_ATTACHMENTS = 5;
export const MAX_TICKET_ATTACHMENT_BYTES = 2 * 1024 * 1024;

const ACCEPTED_TYPES = "image/jpeg,image/png,image/webp,image/gif,application/pdf";

export function hasOversizedAttachment(files: File[]): boolean {
  return files.some((f) => f.size > MAX_TICKET_ATTACHMENT_BYTES);
}

export function AttachmentPicker({
  files,
  onChange,
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = ""; // lets picking the exact same file again re-fire onChange
    if (picked.length === 0) return;
    onChange([...files, ...picked].slice(0, MAX_TICKET_ATTACHMENTS));
  }

  function handleRemove(index: number) {
    onChange(files.filter((_, i) => i !== index));
  }

  const oversized = files.filter((f) => f.size > MAX_TICKET_ATTACHMENT_BYTES);
  const atLimit = files.length >= MAX_TICKET_ATTACHMENTS;

  return (
    <div className="flex flex-col gap-2">
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((file, i) => (
            <div key={`${file.name}-${i}`} className="relative h-16 w-16 overflow-hidden rounded-md border border-border bg-surface">
              {file.type.startsWith("image/") ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local blob: preview of a not-yet-uploaded File, not a remote asset
                <img src={URL.createObjectURL(file)} alt={file.name} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-0.5 p-1 text-muted">
                  <FileIcon className="h-5 w-5" />
                  <span className="line-clamp-2 break-all text-center text-[9px]">{file.name}</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => handleRemove(i)}
                aria-label={`Remove ${file.name}`}
                className="absolute right-0 top-0 flex h-4 w-4 items-center justify-center rounded-bl bg-black/60 text-[10px] text-white hover:bg-black/80"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || atLimit}
          className="rounded-md border border-border px-2 py-1 text-xs text-muted hover:bg-surface disabled:opacity-50"
        >
          Attach files
        </button>
        <span className="text-[11px] text-muted">
          {files.length}/{MAX_TICKET_ATTACHMENTS} files, up to 2 MB each
        </span>
      </div>

      {oversized.length > 0 && (
        <p className="text-[11px] text-red-600">
          {oversized.map((f) => f.name).join(", ")} {oversized.length === 1 ? "is" : "are"} over the 2 MB limit -- remove{" "}
          {oversized.length === 1 ? "it" : "them"} before sending.
        </p>
      )}

      <input ref={inputRef} type="file" accept={ACCEPTED_TYPES} multiple hidden onChange={handlePick} />
    </div>
  );
}
