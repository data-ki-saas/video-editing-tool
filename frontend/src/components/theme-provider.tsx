"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  ColorTheme,
  DEFAULT_COLOR_THEME,
  DEFAULT_THEME_MODE,
  THEME_STORAGE_KEY,
  ThemeMode,
} from "@/lib/theme";

interface ThemeContextValue {
  mode: ThemeMode;
  colorTheme: ColorTheme;
  setMode: (mode: ThemeMode) => void;
  setColorTheme: (colorTheme: ColorTheme) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveIsDark(mode: ThemeMode): boolean {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyToDocument(mode: ThemeMode, colorTheme: ColorTheme) {
  const root = document.documentElement;
  root.dataset.colorTheme = colorTheme;
  root.classList.toggle("dark", resolveIsDark(mode));
}

function readStoredTheme(): { mode: ThemeMode; colorTheme: ColorTheme } {
  const fallback = { mode: DEFAULT_THEME_MODE, colorTheme: DEFAULT_COLOR_THEME };
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!stored) return fallback;
    const parsed = JSON.parse(stored);
    return {
      mode: parsed.mode ?? fallback.mode,
      colorTheme: parsed.colorTheme ?? fallback.colorTheme,
    };
  } catch {
    return fallback;
  }
}

/** Mirrors ../data/frontend/src/components/theme-provider.tsx, minus the
 * backend-sync half (that project also persists to a user_settings table
 * and pulls it on login via theme-sync.tsx + react-query -- this app has
 * neither a settings table nor react-query yet, and cross-device theme
 * sync isn't worth adding either dependency for on its own). Deliberate
 * simplification: local to this browser only, via localStorage. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // The inline script in layout.tsx already applied whatever was in
  // localStorage before paint; this lazy init just brings React state in
  // sync with it on the client without an extra render pass.
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredTheme().mode);
  const [colorTheme, setColorThemeState] = useState<ColorTheme>(
    () => readStoredTheme().colorTheme
  );

  useEffect(() => {
    applyToDocument(mode, colorTheme);
    window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ mode, colorTheme }));
  }, [mode, colorTheme]);

  useEffect(() => {
    if (mode !== "system") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => applyToDocument(mode, colorTheme);
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }, [mode, colorTheme]);

  const setMode = useCallback((next: ThemeMode) => setModeState(next), []);
  const setColorTheme = useCallback((next: ColorTheme) => setColorThemeState(next), []);

  const value = useMemo(
    () => ({ mode, colorTheme, setMode, setColorTheme }),
    [mode, colorTheme, setMode, setColorTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
