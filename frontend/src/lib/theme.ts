export const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

// Same palette as ../data/frontend/src/lib/theme.ts -- reused, not
// reinvented, per the explicit instruction to pick this from that project.
export const COLOR_THEMES = [
  { value: "winter", label: "Winter", swatch: "#2563eb" },
  { value: "pastel", label: "Pastel", swatch: "#c98bd0" },
  { value: "photochromatic", label: "Photochromatic", swatch: "#8b5cf6" },
  { value: "warm", label: "Warm", swatch: "#d97706" },
  { value: "spring", label: "Spring", swatch: "#16a34a" },
  { value: "contrast", label: "Contrast", swatch: "#000000" },
] as const;
export type ColorTheme = (typeof COLOR_THEMES)[number]["value"];

export const DEFAULT_THEME_MODE: ThemeMode = "system";
export const DEFAULT_COLOR_THEME: ColorTheme = "winter";

// Read by the no-flash inline script in layout.tsx before React hydrates —
// keep this key in sync with that script and theme-provider.tsx.
export const THEME_STORAGE_KEY = "reel-creator-theme";
