// Card content for HeroLanguageCarousel.tsx. Limited to the languages that
// actually have a working pre-generated voiceover -- Edge TTS's live voice
// catalog has NO Punjabi (pa-*) or Odia (or-*) voice at all (confirmed
// against `edge-tts --list-voices`, ~324 entries, zero matches), even
// though backend/src/tts/providers/edge_provider.py lists 4 pa-IN/or-IN
// voice IDs for the niche-script TTS feature -- those are dead entries and
// synthesis for those two languages fails app-wide, not just here. If that
// gets fixed with a different TTS provider, add pa/or cards here too.
//
// Audio files live in public/audio/hero-carousel/ -- regenerate with the
// Edge TTS CLI (`edge-tts --voice <id> --file <text.txt> --write-media
// <lang>.mp3`, one female voice per language, matching edge_provider.py's
// existing catalog order) if the tagline copy ever changes.
export type HeroCarouselCard = {
  /** BCP-47 locale, used for the audio file name and the card text's `lang` attribute. */
  locale: string;
  /** Language name written in its own script. */
  nativeName: string;
  /** English gloss shown alongside nativeName for readers who don't know the script. */
  englishName: string;
  /** The tagline, translated into this card's language -- this is exactly what the audio reads aloud. */
  tagline: string;
  audioSrc: string;
};

export const HERO_CAROUSEL_CARDS: HeroCarouselCard[] = [
  {
    locale: "en-IN",
    nativeName: "English",
    englishName: "English",
    tagline: "MyReels.in is the best online resource to build YouTube reels in Indian languages.",
    audioSrc: "/audio/hero-carousel/en.mp3",
  },
  {
    locale: "hi-IN",
    nativeName: "हिन्दी",
    englishName: "Hindi",
    tagline: "MyReels.in भारतीय भाषाओं में यूट्यूब रील्स बनाने के लिए सबसे अच्छा ऑनलाइन संसाधन है।",
    audioSrc: "/audio/hero-carousel/hi.mp3",
  },
  {
    locale: "mr-IN",
    nativeName: "मराठी",
    englishName: "Marathi",
    tagline: "MyReels.in भारतीय भाषांमध्ये यूट्यूब रील्स तयार करण्यासाठी सर्वोत्तम ऑनलाइन संसाधन आहे.",
    audioSrc: "/audio/hero-carousel/mr.mp3",
  },
  {
    locale: "bn-IN",
    nativeName: "বাংলা",
    englishName: "Bengali",
    tagline: "MyReels.in ভারতীয় ভাষায় ইউটিউব রিল তৈরি করার জন্য সেরা অনলাইন সম্পদ।",
    audioSrc: "/audio/hero-carousel/bn.mp3",
  },
  {
    locale: "ta-IN",
    nativeName: "தமிழ்",
    englishName: "Tamil",
    tagline: "MyReels.in இந்திய மொழிகளில் யூடியூப் ரீல்களை உருவாக்க சிறந்த ஆன்லைன் தளமாகும்.",
    audioSrc: "/audio/hero-carousel/ta.mp3",
  },
];
