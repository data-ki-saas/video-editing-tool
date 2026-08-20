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

export interface NicheConfig {
  id: string;
  niche_key: string;
  display_name: string;
  fields: NicheField[];
  script_template: string | null;
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
