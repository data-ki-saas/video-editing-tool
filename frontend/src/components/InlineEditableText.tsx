"use client";

/**
 * A text label that turns into an input on click, committing the new value
 * via `onCommit` on Enter or blur, and reverting on Escape. Generic UI
 * primitive (not tied to reel names specifically) so any other "click a
 * name to rename it" spot can reuse it.
 */
import { useEffect, useRef, useState } from "react";

export function InlineEditableText({
  value,
  onCommit,
  className,
  inputClassName,
  ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  className?: string;
  inputClassName?: string;
  ariaLabel?: string;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keeps the draft in sync with an externally-updated value while not
  // mid-edit -- e.g. if the commit above gets reverted by the caller after
  // a failed save.
  useEffect(() => {
    if (!isEditing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraft(value);
    }
  }, [value, isEditing]);

  useEffect(() => {
    if (isEditing) inputRef.current?.select();
  }, [isEditing]);

  function commit() {
    const trimmed = draft.trim();
    setIsEditing(false);
    if (trimmed && trimmed !== value) onCommit(trimmed);
    else setDraft(value);
  }

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(value);
            setIsEditing(false);
          }
        }}
        aria-label={ariaLabel}
        className={inputClassName ?? className}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setIsEditing(true)}
      title="Click to rename"
      aria-label={ariaLabel}
      className={`text-left ${className ?? ""}`}
    >
      {value}
    </button>
  );
}
