"use client";

// Hero-section carousel: one card per supported language, each showing a
// placeholder portrait + the site's tagline translated into that language,
// with a pre-generated TTS voiceover (see heroCarouselData.ts) reading the
// card aloud while it's on screen. Starts muted (browsers block audible
// autoplay without a user gesture anyway) and auto-advances on a timer;
// unmuting switches the advance to "wait for this card's audio to finish".

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { SpeakerFullIcon, SpeakerMutedIcon } from "@/components/icons/UIIcons";
import { HERO_CAROUSEL_CARDS } from "./heroCarouselData";

const AUTO_ADVANCE_MS = 4500;
// Longer than any real tagline audio (~4-6s) -- only kicks in if 'ended'
// never fires (slow network, missing file, autoplay rejected).
const AUDIO_FALLBACK_MS = 8000;
const SWIPE_THRESHOLD_PX = 40;

function PlaceholderPortrait({ label }: { label: string }) {
  const gradientId = `hero-carousel-portrait-${useId().replace(/:/g, "")}`;
  return (
    <div className="relative flex aspect-[3/4] w-full items-center justify-center overflow-hidden bg-accent/10">
      <svg viewBox="0 0 24 24" className="h-16 w-16 text-accent/50" aria-hidden>
        <defs>
          <linearGradient id={gradientId} x1="4" y1="4" x2="20" y2="20" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.8" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0.4" />
          </linearGradient>
        </defs>
        <circle cx="12" cy="8.5" r="4.5" fill={`url(#${gradientId})`} />
        <path d="M4 21a8 8 0 0 1 16 0Z" fill={`url(#${gradientId})`} />
      </svg>
      <span className="absolute left-2 top-2 rounded-full border border-dashed border-border bg-surface/80 px-2 py-0.5 text-[11px] text-muted">
        Artwork coming soon
      </span>
      <span className="absolute bottom-2 right-2 rounded-full border border-border bg-surface/90 px-2.5 py-1 text-xs font-medium text-foreground">
        {label}
      </span>
    </div>
  );
}

function ChevronButton({
  direction,
  onClick,
  label,
}: {
  direction: "prev" | "next";
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface text-foreground transition-colors hover:bg-accent/10"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
        <path d={direction === "prev" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
      </svg>
    </button>
  );
}

export function HeroLanguageCarousel() {
  const cards = HERO_CAROUSEL_CARDS;
  const [activeIndex, setActiveIndex] = useState(0);
  const [muted, setMuted] = useState(true);
  const [isPaused, setIsPaused] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const touchStartXRef = useRef<number | null>(null);

  const goTo = useCallback(
    (index: number) => {
      setActiveIndex(((index % cards.length) + cards.length) % cards.length);
    },
    [cards.length],
  );

  useEffect(() => {
    if (isPaused) return;
    const audio = audioRef.current;
    const holdMs = muted || !audio ? AUTO_ADVANCE_MS : AUDIO_FALLBACK_MS;
    const timer = setTimeout(() => goTo(activeIndex + 1), holdMs);

    if (!muted && audio) {
      audio.src = cards[activeIndex].audioSrc;
      audio.currentTime = 0;
      // Autoplay can still be rejected (e.g. permissions changed mid-session)
      // -- the timed fallback above covers that case, so the catch is silent.
      audio.play().catch(() => {});
    }

    return () => {
      clearTimeout(timer);
      audio?.pause();
    };
  }, [activeIndex, muted, isPaused, cards, goTo]);

  function handleAudioEnded() {
    goTo(activeIndex + 1);
  }

  function handleToggleMute() {
    setMuted((prev) => {
      const next = !prev;
      const audio = audioRef.current;
      if (audio) {
        if (next) {
          audio.pause();
        } else {
          // First play() call happens directly inside this click handler so
          // it carries the user gesture browsers require for audible autoplay.
          audio.src = cards[activeIndex].audioSrc;
          audio.currentTime = 0;
          audio.play().catch(() => {});
        }
      }
      return next;
    });
  }

  function handleTouchStart(e: React.TouchEvent) {
    touchStartXRef.current = e.touches[0]?.clientX ?? null;
  }

  function handleTouchEnd(e: React.TouchEvent) {
    const startX = touchStartXRef.current;
    touchStartXRef.current = null;
    if (startX == null) return;
    const deltaX = (e.changedTouches[0]?.clientX ?? startX) - startX;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return;
    goTo(activeIndex + (deltaX < 0 ? 1 : -1));
  }

  return (
    <div
      className="flex w-full flex-col items-center gap-3"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <div className="flex w-full max-w-xs items-center gap-2 sm:max-w-sm">
        <ChevronButton direction="prev" label="Previous language" onClick={() => goTo(activeIndex - 1)} />

        <div
          className="flex-1 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <div
            className="flex transition-transform duration-500 ease-out"
            style={{ transform: `translateX(-${activeIndex * 100}%)` }}
          >
            {cards.map((card) => (
              <div key={card.locale} className="w-full shrink-0">
                <PlaceholderPortrait
                  label={card.nativeName === card.englishName ? card.englishName : `${card.nativeName} · ${card.englishName}`}
                />
                <p lang={card.locale} className="p-4 text-left text-sm leading-relaxed text-foreground">
                  {card.tagline}
                </p>
              </div>
            ))}
          </div>
        </div>

        <ChevronButton direction="next" label="Next language" onClick={() => goTo(activeIndex + 1)} />
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          {cards.map((card, index) => (
            <button
              key={card.locale}
              type="button"
              aria-label={`Show ${card.englishName} card`}
              onClick={() => goTo(index)}
              className={`h-1.5 rounded-full transition-all ${
                index === activeIndex ? "w-5 bg-accent" : "w-1.5 bg-border"
              }`}
            />
          ))}
        </div>
        <button
          type="button"
          onClick={handleToggleMute}
          aria-label={muted ? "Play voiceover" : "Mute voiceover"}
          className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface text-muted transition-colors hover:text-foreground"
        >
          {muted ? <SpeakerMutedIcon className="h-3.5 w-3.5" /> : <SpeakerFullIcon className="h-3.5 w-3.5" />}
        </button>
      </div>

      <audio ref={audioRef} onEnded={handleAudioEnded} />
    </div>
  );
}
