"use client";

/**
 * "Promote to the global library" -- lets a creator share one of their own
 * generated avatars (AvatarsPage's grid) with every other user, for anyone
 * to pull into their own reel via LibraryAssetDialog's "+ Library" -> Avatars
 * tab. Requires a title, an optional short (1-4 line) description, and
 * ticking a liability waiver -- there's no existing consent-checkbox
 * pattern anywhere else in this codebase to reuse, so this is a plain
 * controlled checkbox gating the submit button, re-validated server-side
 * (asset_library/service.py's _validate_promotion_fields).
 *
 * Promoting COPIES the avatar (skin/design + a public atlas image) rather
 * than referencing this row -- the original stays private and editable, and
 * later renaming/deleting it never affects the shared copy (see
 * asset_library/service.py's promote_avatar).
 */
import { useState } from "react";
import { promoteAvatarToLibrary } from "@/lib/api";

const MAX_DESCRIPTION_LINES = 4;
const MAX_DESCRIPTION_CHARS = 480;
const MAX_TITLE_CHARS = 80;

export function PromoteAvatarDialog({
  avatarId,
  defaultTitle,
  onPromoted,
  onClose,
}: {
  avatarId: string;
  defaultTitle: string;
  onPromoted: () => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(defaultTitle);
  const [description, setDescription] = useState("");
  const [waiverAccepted, setWaiverAccepted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const descriptionLineCount = description.split("\n").length;
  const canSubmit = title.trim().length > 0 && waiverAccepted && !isSubmitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await promoteAvatarToLibrary(avatarId, title.trim(), description.trim(), waiverAccepted);
      onPromoted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add this avatar to the library");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Promote to the library" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col gap-3 rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Add to the global library</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>
        <p className="text-[11px] text-muted">
          Sharing this makes it visible to every user, who can add a copy of it to their own reel. Your original avatar stays
          private and untouched.
        </p>

        <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
          Title
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, MAX_TITLE_CHARS))}
            placeholder="Give this avatar a name for the library"
            className="rounded-md border border-border bg-background px-2 py-1 text-sm font-normal"
            maxLength={MAX_TITLE_CHARS}
            required
          />
        </label>

        <label className="flex flex-col gap-1 text-xs font-medium text-foreground">
          Description <span className="font-normal text-muted">(optional, up to {MAX_DESCRIPTION_LINES} lines)</span>
          <textarea
            value={description}
            onChange={(e) => {
              const next = e.target.value;
              if (next.split("\n").length <= MAX_DESCRIPTION_LINES && next.length <= MAX_DESCRIPTION_CHARS) setDescription(next);
            }}
            rows={4}
            placeholder="What is this avatar, who is it good for?"
            className="resize-none rounded-md border border-border bg-background px-2 py-1 text-sm font-normal"
          />
          <span className="self-end text-[10px] text-muted">
            {descriptionLineCount}/{MAX_DESCRIPTION_LINES} lines
          </span>
        </label>

        <label className="flex items-start gap-2 text-[11px] text-foreground">
          <input
            type="checkbox"
            checked={waiverAccepted}
            onChange={(e) => setWaiverAccepted(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I confirm I have the right to share this avatar, and I allow anyone to use it in their own reels with no liability
            to me.
          </span>
        </label>

        {error && <p className="text-xs text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={!canSubmit}
          className="mt-1 w-full rounded-md bg-accent py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-50"
        >
          {isSubmitting ? "Adding…" : "Add to library"}
        </button>
      </form>
    </div>
  );
}
