import { createClient } from "@/lib/supabase/client";
import type { CropRect, ZoomEffect } from "@/lib/video/video_math";

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

// A snapshot of the editor-v2 selections that actually change what the
// frames look like, at some point in the edit history -- see
// lib/useEditHistory.ts. Kept generic there; named here since this is the
// one concrete shape actually persisted. Template and background-track
// choices are NOT part of this: they don't affect frames (yet), so they're
// plain persisted fields on Timeline below rather than history entries --
// only actions that change frames belong in the visible change list.
//
// Every frame-affecting transform is a manipulation of the ONE clip
// rectangle: its size (drag the corner) is the crop/zoom target, its
// position (drag the body) is the pan/tilt target, both changing over time
// is a transition effect (each ZoomEffect handles zoom AND pan -- a "move
// without resizing between two points in time" is a pan through the exact
// same mechanism), and flipHorizontal/flipVertical are toggled from
// handles on the rect's own edges. Grows as more transform types land.
export interface EditSelectionsSnapshot {
  clipRectId: string | null;
  // The clip rectangle's actual position/size (fractions of the frame --
  // see video_math.ts's CropRect) -- the clip's fixed, ongoing property.
  // Independent of clipRectId once the user drags/resizes it away from
  // that ratio's default max-coverage position.
  cropRect: CropRect | null;
  // Any number of transitions can coexist on one clip, each occupying its
  // own non-overlapping time range -- see lib/video/transformations.ts's
  // applyCropRectCommit for how a drag decides whether to create a new one
  // or reshape an existing one it falls inside, and how a new one is
  // clamped to not overlap whatever's already there.
  zoomEffects: ZoomEffect[];
  // "Flip" (left/right handles -- mirrors left-right) and "Mirror"
  // (top/bottom handles -- mirrors top-bottom), matching Premiere/
  // Photoshop's "Flip Horizontal"/"Flip Vertical" naming underneath more
  // approachable labels. Applied uniformly to the whole clip, not
  // time-varying like zoomEffects.
  flipHorizontal: boolean;
  flipVertical: boolean;
}

export interface EditHistoryEntrySnapshot {
  label: string;
  state: EditSelectionsSnapshot;
  at: number;
}

export interface Timeline {
  output_format: "mp4";
  width: number;
  height: number;
  elements: TemplateElement[];
  _appMeta: Record<string, AppMetaEntry>;
  // Persists ThreePaneEditor's undo-able change list (see
  // lib/useEditHistory.ts) so reopening a reel resumes with the same
  // history and current selection, not a blank slate. Optional/absent on
  // any timeline saved before this existed.
  editHistory?: EditHistoryEntrySnapshot[];
  editHistoryIndex?: number;
  // Cosmetic-only selections (see EditSelectionsSnapshot's comment above) --
  // persisted directly rather than through the change history.
  selectedTemplateId?: string | null;
  selectedBackgroundTrackId?: string;
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
  // render_error: set once render_status = 'failed' -- a human-readable
  // reason from either Creatomate itself or the render-transfer worker (see
  // app/api/webhooks/creatomate/route.ts and worker/src/server.js).
  // render_started_at: when the current render attempt began; used
  // client-side (see lib/useRenderStatus.ts) to warn if a render has been
  // non-terminal for far longer than normal.
  render_error: string | null;
  render_started_at: string | null;
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
  // .select("id") forces PostgREST to return the updated row(s) -- without
  // it, an update that matches zero rows (e.g. the session was cleared by a
  // sign-out racing this call, so RLS filters the write to nothing) still
  // reports success with no `error`, and the save would silently no-op.
  const { data, error } = await supabase.from("projects").update({ timeline }).eq("id", projectId).select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error("Save didn't apply -- your session may have expired");
  }
}

export async function renameProject(projectId: string, name: string): Promise<void> {
  const supabase = createClient();
  // .select("id") for the same reason as saveTimeline above -- an update
  // that matches zero rows still reports success with no `error` otherwise.
  const { data, error } = await supabase.from("projects").update({ name }).eq("id", projectId).select("id");
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error("Rename didn't apply -- your session may have expired");
  }
}

export async function deleteProject(projectId: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.from("projects").delete().eq("id", projectId);
  if (error) throw new Error(error.message);
}
