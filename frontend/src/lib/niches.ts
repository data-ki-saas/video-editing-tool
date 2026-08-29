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
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.detail === "string" ? body.detail : `Request failed (HTTP ${response.status})`);
  }
  return response.json();
}

export async function listNiches() {
  const response = await fetch(`${API_BASE_URL}/api/niches`, { headers: await authHeader() });
  return handleResponse<NicheConfig[]>(response);
}

/** Looks up a niche by name, or has the backend's configured LLM provider
 * generate a new field schema + voiceover script template for it (cached
 * from then on for every user, not just this one) -- see
 * backend/src/niches/service.py. Can take a few seconds the first time any
 * given niche is requested; instant on every call after that. */
export async function getOrCreateNiche(name: string) {
  const response = await fetch(`${API_BASE_URL}/api/niches`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ name }),
  });
  return handleResponse<NicheConfig>(response);
}
