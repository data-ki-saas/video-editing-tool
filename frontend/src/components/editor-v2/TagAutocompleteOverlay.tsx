"use client";

/**
 * Wraps a script textarea (TtsOverlayDialog's own TransliterateTextarea) with
 * a Slack/Notion-style "{"-triggered autocomplete for this app's closed
 * gesture/gaze/mood tag vocabulary (avatar/tags.ts's AVATAR_TAG_CATALOG) --
 * typing "{wave" pops a filtered dropdown of matching tag ids, grouped by
 * layer; Enter/Tab/click accepts, replacing from the open "{" through the
 * caret with "{id} ".
 *
 * TransliterateTextarea forwards no ref and exposes no caret position of its
 * own (it owns a private caret-restore effect for transliteration, see that
 * file's own module comment) -- rather than changing a component every other
 * script-authoring dialog also depends on, this instead wraps it in a plain
 * `<div>` and reads the CARET/VALUE straight off the bubbled native
 * click/keyup/keydown events themselves (React's synthetic events bubble
 * from any descendant DOM node up through ancestor handlers regardless of
 * the descendant component's own prop surface), so `TransliterateTextarea`
 * itself needs no changes at all.
 *
 * Positioning is a fixed anchor under the textarea's own bottom-left corner,
 * not literal caret-pixel tracking -- true caret-position tracking inside a
 * plain (non-contentEditable) `<textarea>` needs a hidden mirror-div hack,
 * which is overkill for this dialog's own short, fully-visible 2-3 row box.
 */
import { useState, type ReactNode } from "react";
import { AVATAR_TAG_CATALOG, type AvatarTagCatalogEntry, type TagLayer } from "@/lib/video/avatar/tags";

const LAYER_LABELS: Record<TagLayer, string> = {
  mood: "Mood",
  gesture: "Gesture",
  gaze: "Gaze",
};

// Matches "{" followed by zero or more letters, right at the end of the
// string (i.e. right at the caret) -- an already-closed "{wave}" stops
// matching the instant its own "}" is typed, so the dropdown only shows
// while a tag is genuinely being composed.
const OPEN_TAG_QUERY_RE = /\{([a-zA-Z]*)$/;

interface ActiveQuery {
  prefix: string;
  // The caret position (into `text`) the query was captured at -- also
  // where the eventually-accepted tag gets inserted up through.
  caret: number;
}

export function TagAutocompleteOverlay({ text, onChangeText, children }: { text: string; onChangeText: (next: string) => void; children: ReactNode }) {
  const [query, setQuery] = useState<ActiveQuery | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const filtered = query
    ? AVATAR_TAG_CATALOG.filter((entry) => entry.id.toLowerCase().startsWith(query.prefix.toLowerCase()))
    : [];

  function detectQuery(value: string, caret: number) {
    const match = OPEN_TAG_QUERY_RE.exec(value.slice(0, caret));
    if (match) {
      setQuery({ prefix: match[1], caret });
      setHighlightedIndex(0);
    } else {
      setQuery(null);
    }
  }

  // Typed against the wrapping <div> (not HTMLTextAreaElement) since that's
  // what these handlers are actually attached to -- `e.target` at runtime is
  // still the real, bubbled-from descendant <textarea> DOM node regardless
  // of this component's own generic type parameter.
  function handleBubbledSelectionEvent(e: React.SyntheticEvent<HTMLDivElement>) {
    const target = e.target as HTMLTextAreaElement;
    if (typeof target.selectionStart !== "number") return;
    detectQuery(target.value, target.selectionStart);
  }

  function acceptEntry(entry: AvatarTagCatalogEntry) {
    if (!query) return;
    const openBraceIndex = query.caret - 1 - query.prefix.length;
    const before = text.slice(0, Math.max(openBraceIndex, 0));
    const after = text.slice(query.caret);
    onChangeText(`${before}{${entry.id}} ${after}`);
    setQuery(null);
  }

  function handleBubbledKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!query || filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      acceptEntry(filtered[highlightedIndex]);
    } else if (e.key === "Escape") {
      setQuery(null);
    }
  }

  // Grouped in a fixed, stable order (Mood, Gesture, Gaze) regardless of
  // AVATAR_TAG_CATALOG's own build order, so the dropdown's section order
  // never shuffles between renders.
  const groups: { layer: TagLayer; entries: AvatarTagCatalogEntry[] }[] = (["mood", "gesture", "gaze"] as const)
    .map((layer) => ({ layer, entries: filtered.filter((entry) => entry.layer === layer) }))
    .filter((group) => group.entries.length > 0);

  return (
    <div className="relative" onClick={handleBubbledSelectionEvent} onKeyUp={handleBubbledSelectionEvent} onKeyDown={handleBubbledKeyDown}>
      {children}
      {query && groups.length > 0 && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-20 mt-1 max-h-48 w-56 overflow-y-auto rounded-md border border-border bg-surface shadow-lg"
        >
          {groups.map((group) => (
            <div key={group.layer}>
              <div className="px-2 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{LAYER_LABELS[group.layer]}</div>
              {group.entries.map((entry) => {
                const isHighlighted = filtered[highlightedIndex] === entry;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={isHighlighted}
                    // Keeps focus (and the caret) in the textarea -- a plain
                    // button click would otherwise steal focus before onClick
                    // fires, which is what acceptEntry actually depends on
                    // (query.caret was captured from the textarea's own
                    // selection).
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => acceptEntry(entry)}
                    className={
                      "flex w-full items-center px-2 py-1 text-left text-xs text-foreground " +
                      (isHighlighted ? "bg-accent/10" : "hover:bg-background")
                    }
                  >
                    {entry.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
