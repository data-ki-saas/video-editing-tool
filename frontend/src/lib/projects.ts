import { createClient } from "@/lib/supabase/client";

export interface TemplateElement {
  id: string;
  [key: string]: unknown;
}

export type ElementRole = "clip" | "voiceover" | "music" | "text";

export interface AppMetaEntry {
  assetId?: string;
  role: ElementRole;
  presetId?: string;
}

export interface Timeline {
  output_format: "mp4";
  width: number;
  height: number;
  elements: TemplateElement[];
  _appMeta: Record<string, AppMetaEntry>;
}

// Generic on purpose -- what fields matter for a "listing" varies entirely
// by business (see @/lib/niches for the LLM-driven per-niche field schema).
// `attributes` never has an enforced shape; `niche` just links it back to
// whichever NicheConfig scaffolded the "New Reel" form that created it.
export interface Project {
  id: string;
  owner_id: string;
  name: string;
  niche: string | null;
  attributes: Record<string, string | number>;
  timeline: Timeline;
  render_id: string | null;
  render_status: string | null;
  render_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewProjectInput {
  name: string;
  niche?: string;
  attributes?: Record<string, string | number>;
}

export async function listProjects(): Promise<Project[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

export async function getProject(projectId: string): Promise<Project> {
  const supabase = createClient();
  const { data, error } = await supabase.from("projects").select("*").eq("id", projectId).single();
  if (error) throw new Error(error.message);
  return data;
}

export async function createProject(input: NewProjectInput): Promise<Project> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const { data, error } = await supabase
    .from("projects")
    .insert({
      owner_id: user.id,
      name: input.name,
      niche: input.niche ?? null,
      attributes: input.attributes ?? {},
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function saveTimeline(projectId: string, timeline: Timeline): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.from("projects").update({ timeline }).eq("id", projectId);
  if (error) throw new Error(error.message);
}

export async function deleteProject(projectId: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.from("projects").delete().eq("id", projectId);
  if (error) throw new Error(error.message);
}
