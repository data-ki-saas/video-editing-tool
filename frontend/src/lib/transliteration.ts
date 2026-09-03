import Sanscript from "@indic-transliteration/sanscript";

/** Mirrors backend/src/niches/service.py's _LANGUAGE_INFO -- locale prefix
 * (the part of a TTS voice's `locale` before the "-") to the Sanscript
 * target script + source romanization scheme used to convert phonetic
 * Latin typing ("kaise ho") into that script ("कैसे हो") live, the same way
 * Google Input Tools' Hindi phonetic keyboard works. `itrans_dravidian` is
 * Sanscript's Dravidian-tuned ITRANS variant (better retroflex/vowel
 * mapping for Tamil than the Indo-Aryan-oriented plain `itrans`). */
export const LANGUAGE_SCRIPTS: Record<string, { toScript: string; fromScheme: string }> = {
  hi: { toScript: "devanagari", fromScheme: "itrans" },
  mr: { toScript: "devanagari", fromScheme: "itrans" },
  pa: { toScript: "gurmukhi", fromScheme: "itrans" },
  bn: { toScript: "bengali", fromScheme: "itrans" },
  ta: { toScript: "tamil", fromScheme: "itrans_dravidian" },
  or: { toScript: "oriya", fromScheme: "itrans" },
};

/** Reads the 2-letter language prefix off a full BCP-47 locale (e.g.
 * "hi-IN" -> "hi") and looks it up in LANGUAGE_SCRIPTS. Returns null for
 * English/unmapped locales -- callers treat that as "no transliteration,
 * plain passthrough typing". */
export function transliterationForLocale(locale: string | null | undefined) {
  if (!locale) return null;
  const prefix = locale.split("-")[0]?.toLowerCase();
  return LANGUAGE_SCRIPTS[prefix ?? ""] ?? null;
}

/** Converts one phonetic-Latin word to the target Indian script. Exposed
 * separately from the scheme lookup so TransliterateField.tsx can call it
 * per word-boundary without re-deriving the scheme on every keystroke. */
export function transliterateWord(word: string, scheme: { toScript: string; fromScheme: string }): string {
  if (!word) return word;
  return Sanscript.t(word, scheme.fromScheme, scheme.toScript);
}
