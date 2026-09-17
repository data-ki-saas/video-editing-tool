/**
 * Script tags -- "{angry}", "{wave}", "{lookLeft}" typed directly into a TTS
 * narration script (TtsOverlayDialog's textarea), stripped before the text
 * ever reaches speech synthesis and turned into a precise trigger time once
 * the real per-word timing comes back. Pure string/array math, no network
 * calls -- resolving an UNRECOGNIZED tag has no fuzzy matching here at all;
 * that's api.ts's resolveAvatarTag (a small LLM call), kept in this file's
 * caller rather than this module so tags.ts stays synchronous and testable.
 *
 * `AVATAR_TAG_CATALOG` below is built from library.ts's ONE seed topology --
 * TtsOverlay/AvatarOverlayClip are only ever loosely time-overlapping (see
 * video_math.ts's findOverlappingTtsOverlay's own doc comment), so a script's
 * tags can't be resolved against "whichever avatar this narration will pair
 * with" at authoring time; there IS no such single avatar yet, and may never
 * be one. Since every seed/generated avatar in this app rides the same
 * "biped-simple" topology (avatar_gen's own design), one global catalog is
 * accurate today -- a second topology with a DIFFERENT gesture/gaze/mood
 * vocabulary would need this to become per-avatar, which buildAvatarTagCatalog
 * below already supports (it takes any topology), just not wired up that way
 * yet.
 */
import { BIPED_SIMPLE_TOPOLOGY } from "./library";
import type { AvatarTopology } from "./topology";
import type { ResolvedTagAnchor, TtsWordTiming } from "../video_math";

export type TagLayer = "gesture" | "gaze" | "mood";

export interface AvatarTagCatalogEntry {
  layer: TagLayer;
  id: string;
  label: string;
}

// "lookLeft" -> "Look Left" -- same humanizing convention
// AvatarFramingDialog.tsx's humanizeActionId already uses for an action id
// with no explicit label.
function humanizeTagId(id: string): string {
  const spaced = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim();
  if (spaced === "") return id;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Builds the closed tag vocabulary from one topology's own resolved
 * gesture/gaze/moodPreset ids -- a topology declaring none of these (any
 * topology before the layered-motion redesign) simply produces an empty
 * catalog, not an error. */
export function buildAvatarTagCatalog(topology: Pick<AvatarTopology, "gestures" | "gazes" | "moodPresets">): AvatarTagCatalogEntry[] {
  const entries: AvatarTagCatalogEntry[] = [];
  for (const id of Object.keys(topology.gestures ?? {})) entries.push({ layer: "gesture", id, label: humanizeTagId(id) });
  for (const id of Object.keys(topology.gazes ?? {})) entries.push({ layer: "gaze", id, label: humanizeTagId(id) });
  for (const id of Object.keys(topology.moodPresets ?? {})) entries.push({ layer: "mood", id, label: humanizeTagId(id) });
  return entries;
}

export const AVATAR_TAG_CATALOG: AvatarTagCatalogEntry[] = buildAvatarTagCatalog(BIPED_SIMPLE_TOPOLOGY);

const TAG_RE = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

export interface ParsedTagAnchor {
  raw: string;
  layer: TagLayer;
  id: string;
  // 0-based index into the STRIPPED text's own whitespace-split word list --
  // the only position concept resolveTagAnchorsToTimings below can map onto
  // a real per-word timestamp (there's no character-offset-into-audio, only
  // discrete per-word timings from edge-tts).
  beforeWordIndex: number;
}

/** A "{word}" that matched the tag SHAPE but not a known id -- still
 * stripped out of `strippedText` (never spoken), but reported here instead
 * of turned into an anchor. Carries its own `beforeWordIndex` (same meaning
 * as ParsedTagAnchor's) so the caller (TtsOverlayDialog) can resolve
 * `freeText` via api.ts's resolveAvatarTag and build a real anchor directly
 * from the result, without needing to re-parse the script afterward. */
export interface UnresolvedScriptTag {
  raw: string;
  freeText: string;
  beforeWordIndex: number;
}

export interface ParseScriptTagsResult {
  strippedText: string;
  anchors: ParsedTagAnchor[];
  unresolved: UnresolvedScriptTag[];
}

function countWords(segment: string): number {
  const trimmed = segment.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Strips every "{tag}" occurrence out of `text` and records each recognized
 * one's position as "immediately before the Nth word of the stripped text."
 * Never throws on a malformed/unknown tag -- an unrecognized one is simply
 * routed to `unresolvedRawTags` instead of `anchors`, same "degrade rather
 * than error" posture as the rest of this engine.
 */
export function parseScriptTags(text: string, catalog: AvatarTagCatalogEntry[]): ParseScriptTagsResult {
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry]));
  const anchors: ParsedTagAnchor[] = [];
  const unresolved: UnresolvedScriptTag[] = [];

  let strippedText = "";
  let lastIndex = 0;
  let wordCountSoFar = 0;

  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(text))) {
    const before = text.slice(lastIndex, match.index);
    strippedText += before;
    wordCountSoFar += countWords(before);

    const id = match[1];
    const entry = catalogById.get(id);
    if (entry) {
      anchors.push({ raw: match[0], layer: entry.layer, id: entry.id, beforeWordIndex: wordCountSoFar });
    } else {
      unresolved.push({ raw: match[0], freeText: id, beforeWordIndex: wordCountSoFar });
    }
    lastIndex = TAG_RE.lastIndex;
  }
  strippedText += text.slice(lastIndex);

  // Collapse the run of whitespace a stripped tag leaves behind (e.g.
  // "Hi {wave} there" -> "Hi  there") to a single space, so the actually-
  // spoken text reads naturally rather than with a visible double gap.
  strippedText = strippedText.replace(/[ \t]{2,}/g, " ").trim();

  return { strippedText, anchors, unresolved };
}

/** Maps each anchor's `beforeWordIndex` to a concrete trigger time using the
 * REAL per-word timing the TTS provider returned for the stripped text --
 * that word's own `startMs`, or, for a trailing anchor (a tag typed after
 * the very last word), the last word's own `endMs` instead, since nothing
 * "comes before" a word that doesn't exist. */
export function resolveTagAnchorsToTimings(anchors: ParsedTagAnchor[], wordTimings: TtsWordTiming[]): ResolvedTagAnchor[] {
  if (wordTimings.length === 0) return [];
  return anchors.map((anchor) => {
    const word = wordTimings[anchor.beforeWordIndex];
    const triggerMs = word ? word.startMs : wordTimings[wordTimings.length - 1].endMs;
    return { layer: anchor.layer, id: anchor.id, triggerMs };
  });
}
