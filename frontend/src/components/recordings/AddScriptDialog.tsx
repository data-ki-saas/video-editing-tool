"use client";

/**
 * "Add Script" card's popup on /recordings/scripts -- paste/name a script to
 * save into this user's script library (backend/src/scripts/*). Kept
 * separate from CameraCapturePage's own TeleprompterDialog: that one edits
 * the throwaway draft for the take in progress (no name, no library entry);
 * this one creates a permanently saved, named script other takes can be
 * started from later (see the scripts page's own "Record" card action).
 */
import { useState } from "react";
import { createScript, type Script } from "@/lib/api";

// Mirrors CameraCapturePage.tsx's own TELEPROMPTER_WORDS_PER_SECOND (150
// words/minute read-aloud pace) and backend/src/scripts/schemas.py's
// MAX_SCRIPT_WORDS -- kept in sync by hand across all three, same as that
// backend constant's own comment notes.
const TELEPROMPTER_WORDS_PER_SECOND = 150 / 60;
const MAX_SCRIPT_WORDS = 450;

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AddScriptDialog({
  onSaved,
  onClose,
}: {
  onSaved: (script: Script) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wordCount = countWords(text);
  const isOverLimit = wordCount > MAX_SCRIPT_WORDS;
  const canSave = name.trim().length > 0 && text.trim().length > 0 && !isOverLimit && !isSaving;

  async function handleSave() {
    if (!canSave) return;
    setIsSaving(true);
    setError(null);
    try {
      const script = await createScript(name.trim(), text.trim());
      onSaved(script);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save this script");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add a script"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-md flex-col gap-3 rounded-lg bg-surface p-4 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Add script</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-muted hover:text-foreground">
            ✕
          </button>
        </div>

        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Script name…"
          maxLength={100}
          autoFocus
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-accent"
        />

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste or type your script here…"
          rows={10}
          className={`w-full resize-none rounded-md border bg-background p-2 text-sm outline-none focus:border-accent ${
            isOverLimit ? "border-red-500" : "border-border"
          }`}
        />

        <p className={`text-xs ${isOverLimit ? "text-red-600" : "text-muted"}`}>
          {wordCount} words (~{formatDuration(wordCount / TELEPROMPTER_WORDS_PER_SECOND)}) -- up to {MAX_SCRIPT_WORDS}{" "}
          words (~3:00)
        </p>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md bg-background px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave}
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-accent-foreground disabled:opacity-40"
          >
            {isSaving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
