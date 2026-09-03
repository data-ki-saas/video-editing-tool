"use client";

import { useLayoutEffect, useRef, useState, type ChangeEvent, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { transliterationForLocale, transliterateWord } from "@/lib/transliteration";

// Characters that end a "word" while phonetically typing -- on any of these,
// the word just finished is converted to the target Indian script, same
// live-as-you-type behavior as Google Input Tools' phonetic keyboards.
const WORD_BOUNDARY = /[\s.,!?;:()"'-]/;
// Any character in the Devanagari..Sinhala Unicode block -- covers every
// script this app targets (Devanagari, Bengali, Gurmukhi, Oriya, Tamil).
// Used to skip re-converting a word that's already non-Latin (e.g. exposed
// by a backspace, or typed by the OS's own IME).
const ALREADY_INDIC = /[ऀ-෿]/;

interface BoundaryResult {
  value: string;
  caret: number;
}

/** Converts the Latin word immediately before `caret` in `nextValue` to the
 * target script, if `nextValue` looks like exactly one forward keystroke
 * (a boundary char) past `prevValue` -- returns null for anything else
 * (deletes, pastes, selection-replace, no scheme active), meaning "just
 * pass the value through unchanged". Restricting to single-keystroke
 * inserts is what keeps backspacing through already-converted text from
 * spuriously re-triggering conversion on an untouched earlier word. */
function applyBoundaryTransliteration(
  prevValue: string,
  nextValue: string,
  caret: number,
  scheme: { toScript: string; fromScheme: string } | null
): BoundaryResult | null {
  if (!scheme || nextValue.length !== prevValue.length + 1) return null;

  const justTyped = nextValue.slice(caret - 1, caret);
  if (caret === 0 || !WORD_BOUNDARY.test(justTyped)) return null;

  const beforeBoundary = nextValue.slice(0, caret - 1);
  const match = beforeBoundary.match(/\S+$/);
  if (!match) return null;
  const word = match[0];
  if (ALREADY_INDIC.test(word)) return null;

  const wordStart = beforeBoundary.length - word.length;
  const converted = transliterateWord(word, scheme);
  const value = nextValue.slice(0, wordStart) + converted + nextValue.slice(wordStart + word.length);
  const caret_ = caret + (converted.length - word.length);
  return { value, caret: caret_ };
}

/** The word-boundary conversion above only fires when a boundary character
 * gets typed AFTER a word -- the very last word in a field never gets one
 * (nothing follows it), so it would otherwise stay un-converted forever if
 * the user just tabs/clicks away. Called on blur to flush that trailing
 * word, treating "leaving the field" as an implicit boundary. */
function flushTrailingWord(value: string, scheme: { toScript: string; fromScheme: string } | null): string | null {
  if (!scheme) return null;
  const match = value.match(/\S+$/);
  if (!match) return null;
  const word = match[0];
  if (ALREADY_INDIC.test(word)) return null;
  const wordStart = value.length - word.length;
  const converted = transliterateWord(word, scheme);
  if (converted === word) return null;
  return value.slice(0, wordStart) + converted;
}

interface TransliterateToggleProps {
  active: boolean;
  onToggle: () => void;
}

function TransliterateToggle({ active, onToggle }: TransliterateToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={active ? "Typing in Indian script -- click to type plain Latin" : "Transliteration paused -- click to resume"}
      className="absolute right-1.5 top-1.5 rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] leading-none text-muted hover:text-foreground"
    >
      {active ? "अ" : "A"}
    </button>
  );
}

interface SharedProps {
  value: string;
  onChange: (value: string) => void;
  /** A TTS voice locale (e.g. "hi-IN") or a niche language's representative
   * locale -- null/English locales render as a plain passthrough field with
   * no toggle, identical to a bare input/textarea. */
  locale: string | null | undefined;
}

type TransliterateInputProps = SharedProps & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">;

export function TransliterateInput({ value, onChange, locale, className, ...rest }: TransliterateInputProps) {
  const scheme = transliterationForLocale(locale);
  const ref = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [enabled, setEnabled] = useState(true);

  useLayoutEffect(() => {
    if (pendingCaret.current !== null && ref.current) {
      ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const nextValue = e.target.value;
    const caret = e.target.selectionStart ?? nextValue.length;
    const result = enabled ? applyBoundaryTransliteration(value, nextValue, caret, scheme) : null;
    if (result) {
      pendingCaret.current = result.caret;
      onChange(result.value);
    } else {
      onChange(nextValue);
    }
  }

  if (!scheme) {
    return <input value={value} onChange={(e) => onChange(e.target.value)} className={className} {...rest} />;
  }

  function handleBlur() {
    if (!enabled) return;
    const flushed = flushTrailingWord(value, scheme);
    if (flushed !== null) onChange(flushed);
  }

  return (
    <div className="relative">
      <input ref={ref} value={value} onChange={handleChange} onBlur={handleBlur} className={className} {...rest} />
      <TransliterateToggle active={enabled} onToggle={() => setEnabled((prev) => !prev)} />
    </div>
  );
}

type TransliterateTextareaProps = SharedProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">;

export function TransliterateTextarea({ value, onChange, locale, className, ...rest }: TransliterateTextareaProps) {
  const scheme = transliterationForLocale(locale);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [enabled, setEnabled] = useState(true);

  useLayoutEffect(() => {
    if (pendingCaret.current !== null && ref.current) {
      ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  function handleChange(e: ChangeEvent<HTMLTextAreaElement>) {
    const nextValue = e.target.value;
    const caret = e.target.selectionStart ?? nextValue.length;
    const result = enabled ? applyBoundaryTransliteration(value, nextValue, caret, scheme) : null;
    if (result) {
      pendingCaret.current = result.caret;
      onChange(result.value);
    } else {
      onChange(nextValue);
    }
  }

  if (!scheme) {
    return <textarea value={value} onChange={(e) => onChange(e.target.value)} className={className} {...rest} />;
  }

  function handleBlur() {
    if (!enabled) return;
    const flushed = flushTrailingWord(value, scheme);
    if (flushed !== null) onChange(flushed);
  }

  return (
    <div className="relative">
      <textarea ref={ref} value={value} onChange={handleChange} onBlur={handleBlur} className={className} {...rest} />
      <TransliterateToggle active={enabled} onToggle={() => setEnabled((prev) => !prev)} />
    </div>
  );
}
