import { createClient } from "@/lib/supabase/client";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

async function authHeader(): Promise<HeadersInit> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type NicheFieldType = "text" | "number" | "textarea";

export interface NicheField {
  key: string;
  label: string;
  type: NicheFieldType;
  required: boolean;
}

export type MediaSlotKind = "image" | "video" | "either";

export interface MediaSlot {
  key: string;
  label: string;
  hint: string;
  kind: MediaSlotKind;
  required: boolean;
}

export interface NicheConfig {
  id: string;
  niche_key: string;
  display_name: string;
  fields: NicheField[];
  script_template: string | null;
  // Wizard scaffolding (backend/src/niches/service.py) -- ordered upload
  // slots with per-slot shooting guidance, pre-written opening hooks, an
  // end-screen CTA template, and hashtag stems for future social-copy
  // generation. Not yet consumed by the UI (still the flat 2-step form in
  // dashboard/(chrome)/new/page.tsx) -- typed now so the contract matches
  // the backend as the guided wizard gets built on top of it.
  media_slots: MediaSlot[];
  hooks: string[];
  cta_template: string | null;
  hashtag_seed: string[];
  created_at: string;
  language: string;
}

/** The languages niche script generation supports -- see
 * backend/src/niches/service.py's _LANGUAGE_INFO, which this mirrors.
 * Each label is written in its own script so it's recognizable at a glance
 * rather than needing the reader to know English language names. */
export const NICHE_LANGUAGES: { code: string; label: string; voiceLocalePrefix: string | null }[] = [
  { code: "en", label: "English", voiceLocalePrefix: null },
  { code: "hi", label: "हिंदी", voiceLocalePrefix: "hi" },
  { code: "mr", label: "मराठी", voiceLocalePrefix: "mr" },
  { code: "pa", label: "ਪੰਜਾਬੀ", voiceLocalePrefix: "pa" },
  { code: "bn", label: "বাংলা", voiceLocalePrefix: "bn" },
  { code: "ta", label: "தமிழ்", voiceLocalePrefix: "ta" },
  { code: "or", label: "ଓଡ଼ିଆ", voiceLocalePrefix: "or" },
];

/** Locale a TransliterateInput/TransliterateTextarea should target for a
 * given niche language code -- null means "plain typing, no conversion". */
export function localeForNicheLanguage(languageCode: string): string | null {
  const prefix = NICHE_LANGUAGES.find((l) => l.code === languageCode)?.voiceLocalePrefix;
  return prefix ? `${prefix}-IN` : null;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `Request failed (HTTP ${response.status})`);
  }
  return response.json();
}

export async function listNiches(language?: string) {
  const url = new URL(`${API_BASE_URL}/api/niches`);
  if (language) url.searchParams.set("language", language);
  const response = await fetch(url, { headers: await authHeader() });
  return handleResponse<NicheConfig[]>(response);
}

/** Looks up a niche by name + language, or has the backend's configured LLM
 * provider generate a new field schema + voiceover script/hooks/CTA for it
 * in that language (cached from then on for every user asking for that same
 * niche+language, not just this one) -- see backend/src/niches/service.py.
 * Can take a few seconds the first time any given niche+language pair is
 * requested; instant on every call after that. */
export async function getOrCreateNiche(name: string, language: string = "en") {
  const response = await fetch(`${API_BASE_URL}/api/niches`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ name, language }),
  });
  return handleResponse<NicheConfig>(response);
}
