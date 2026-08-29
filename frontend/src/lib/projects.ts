import { deleteProject as deleteProjectViaBackend, resetProject as resetProjectViaBackend } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import type {
  CropRect,
  ImageOverlayClip,
  SequenceEntry,
  TextOverlay,
  TranscriptCaption,
  TrimRange,
  TtsOverlay,
  VideoOverlayClip,
  ZoomEffect,
} from "@/lib/video/video_math";

export interface TemplateElement {
  id: string;
  [key: string]: unknown;
}

export type ElementRole = "clip" | "voiceover" | "music" | "text" | "image-overlay" | "video-overlay";

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
  // approachable labels. Each is a sorted list of toggle timestamps, not a
  // single whole-clip boolean -- flip is itself now a timeline action:
  // clicking a handle at the current frame toggles that axis from there
  // onward, and clicking again at a later frame toggles it back (see
  // video_math.ts's toggleFlipAt/computeEffectiveFlip).
  flipHorizontalToggles: number[];
  flipVerticalToggles: number[];
  // Cut-out stretches of the clip -- see TrimTrack.tsx's click-to-place
  // gesture and CanvasPlayer's skipTrimmedRanges, which actually skips
  // over them during playback rather than just marking them.
  trimRanges: TrimRange[];
  // Image assets composited on top of the base video, with the same
  // switchable Full-Screen/Picture-in-Picture/Split-Screen layout system as
  // videoOverlays below -- see video_math.ts's ImageOverlayClip. Independent
  // of trimRanges/zoomEffects/flip; multiple can coexist, even at
  // overlapping times (e.g. two different images shown together).
  overlayImages: ImageOverlayClip[];
  // Text captions composited on top of the base video, rendered via a
  // named template (see lib/video/textTemplates.ts) -- same
  // positioned-rect-plus-time-range shape as overlayImages, but the
  // content is authored text rather than an uploaded asset.
  textOverlays: TextOverlay[];
  // TTS-generated narration, each with its own generated audio asset and
  // on-screen caption (static or word-by-word "karaoke") -- see
  // video_math.ts's TtsOverlay. Same positioned-rect-plus-time-range shape
  // as textOverlays, but the content comes from a backend speech-synthesis
  // call rather than a template alone.
  ttsOverlays: TtsOverlay[];
  // Which assets play, in order, concatenated into one continuous
  // sequence -- right-click "Add" on a video asset appends a "video" entry
  // (transformations.ts's applyAddSequenceClip); the "Image Templates"
  // toolbar tool appends an "image" entry, which additionally carries its
  // own authored durationSeconds (images have no intrinsic duration) and
  // templateId (see lib/video/imageTemplates.ts) -- applyAddImageSequenceClip.
  // Every entry has its own `id`, not just an assetId, since the same asset
  // can appear more than once with independent settings. History-tracked
  // (unlike the background-track fields below) because it changes what the
  // frames actually are.
  sequenceClips: SequenceEntry[];
  // A second video asset placed on its own rail for a time window, with a
  // switchable layout (Full-Screen swap / Picture-in-Picture / Split
  // Screen) -- see video_math.ts's VideoOverlayClip. Duration-neutral
  // (unlike the sequence itself): placing one never changes the total
  // output length.
  videoOverlays: VideoOverlayClip[];
  // Auto-generated, speech-driven captions (Creatomate's own transcription
  // -- see lib/video/transcriptCaptionTemplates.ts), as opposed to
  // textOverlays' manually-typed ones. One config for the whole video, not
  // a time-ranged list -- null when disabled. History-tracked since it
  // changes what's on screen, same tier as textOverlays.
  transcriptCaption: TranscriptCaption | null;
}

// Shared by ThreePaneEditor.tsx and editor-mobile/MobileEditor.tsx -- both
// seed useEditHistory with this same empty snapshot, so it lives here once
// rather than as two copies that could drift out of sync with each other or
// with EditSelectionsSnapshot's own field list.
export const DEFAULT_EDIT_SELECTIONS: EditSelectionsSnapshot = {
  clipRectId: null,
  cropRect: null,
  zoomEffects: [],
  flipHorizontalToggles: [],
  flipVerticalToggles: [],
  trimRanges: [],
  overlayImages: [],
  textOverlays: [],
  ttsOverlays: [],
  sequenceClips: [],
  videoOverlays: [],
  transcriptCaption: null,
};

export interface EditHistoryEntrySnapshot {
  label: string;
  state: EditSelectionsSnapshot;
  at: number;
}

/** A named point on the main sequence's own OUTPUT timeline -- purely a
 * planning/organizational aid ("transition to PIP here"), never affects
 * what a frame looks like, so (like `selectedBackgroundTrackId` below)
 * it's a plain persisted Timeline field, not part of
 * EditSelectionsSnapshot/the undo-able change list. See Timeline.markers
 * and MarkerTrack.tsx.
 *
 * A video overlay's own "start point" is NOT one of these -- it's
 * `VideoOverlayClip.sourceStartSeconds` (video_math.ts), a real,
 * undo-tracked field set via OverlaySourceStartDialog, even though that
 * dialog's UI reuses MarkerTrack to edit it.
 */
export interface TimelineMarker {
  timeSeconds: number;
  label: string;
  // Right-click "Pin"/"Unpin" on MarkerTrack's dot -- a pinned marker can't
  // be dragged and renders red instead of amber, so a planning point the
  // user has settled on can't be bumped by an accidental drag. Absent/false
  // means unpinned (every marker saved before this existed reads as
  // unpinned), same optional-field-defaults-to-off convention as the rest
  // of this interface.
  pinned?: boolean;
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
  // Set instead of selectedBackgroundTrackId when the background music is
  // one or more of this project's own assets (via AssetGallery's
  // right-click "Add" on a music tile, which appends -- multiple tracks
  // concatenate, then the whole concatenated sequence loops across the
  // video's duration) rather than a curated BACKGROUND_TRACK_OPTIONS
  // entry -- the two are mutually exclusive, picking one clears the other.
  // `selectedBackgroundAssetId` (singular) is read as a one-item seed if
  // this is absent, for the one commit where the field briefly existed in
  // that shape.
  backgroundSequenceAssetIds?: string[];
  selectedBackgroundAssetId?: string | null;
  // Named points on the main sequence's own OUTPUT timeline -- see
  // TimelineMarker's own doc comment above.
  markers?: TimelineMarker[];
  // Flat 0..1 volume multipliers for the main sequence's own audio and the
  // background music track -- set from the volume button pinned to each
  // rail's own left edge (see VolumeFader.tsx). Plain persisted settings,
  // like selectedBackgroundTrackId above, not undo-tracked: a mix level is
  // a setting, not a content edit. Absent means every reel saved before
  // these controls existed -- see video_math.ts's DEFAULT_MAIN_AUDIO_VOLUME/
  // DEFAULT_BACKGROUND_VOLUME for the exact fallback each reads as, matching
  // what was hardcoded before this existed so an old reel's rendered
  // loudness doesn't change out from under it.
  mainAudioVolume?: number;
  backgroundVolume?: number;
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
  // Widened from Record<string, string|number> to hold the wizard's nested
  // sections (contact: {name,phone,whatsapp}, highlights: string[]) too --
  // still a freeform jsonb column with no enforced shape either way (see
  // @/lib/niches's own comment on why `fields` never becomes real columns).
  attributes: Record<string, unknown>;
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
  // Cover/thumbnail picker (see components/editor-v2/CoverPicker.tsx) --
  // a standalone public R2 image the user downloads and attaches manually
  // when publishing to YouTube/TikTok/IG, not something embedded in the
  // exported video. Backend-owned (like render_*), written via
  // lib/api.ts's uploadThumbnail/clearThumbnail, NOT a direct Supabase
  // write like `timeline` -- see supabase/migrations/
  // 0011_add_project_thumbnail.sql for why.
  thumbnail_url: string | null;
  thumbnail_source: "frame" | "upload" | null;
  // Only meaningful when thumbnail_source === "frame"; null for "upload".
  thumbnail_time_seconds: number | null;
  created_at: string;
  updated_at: string;
}

export interface NewProjectInput {
  name: string;
  niche?: string;
  attributes?: Record<string, unknown>;
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

export async function updateProjectAttributes(projectId: string, attributes: Record<string, unknown>): Promise<void> {
  const supabase = createClient();
  const { data, error } = await supabase.from("projects").update({ attributes }).eq("id", projectId).select("id");
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

// Routed through the FastAPI backend (not a direct Supabase delete like the
// other functions above) -- a project owns R2 objects (every asset's
// storage_key, plus a finished render) that Postgres's `assets` FK cascade
// never reaches. src/projects/service.py cleans those up before removing the
// row itself; deleting the row straight from here would silently orphan them.
export async function deleteProject(projectId: string): Promise<void> {
  await deleteProjectViaBackend(projectId);
}

// Clears a reel back to empty without deleting it -- the "Reset" action
// beside "Delete" in ProjectList. resetProjectViaBackend handles the half
// that needs backend secrets (R2 cleanup for every asset and any finished
// render); blanking `timeline` itself is just a normal saveTimeline call,
// same as every other edit to that column, using the same default shape
// the `timeline` column itself is created with (see supabase/migrations/
// 0004_add_listing_fields_and_timeline_shape.sql).
export async function resetProject(projectId: string): Promise<void> {
  await resetProjectViaBackend(projectId);
  await saveTimeline(projectId, { output_format: "mp4", width: 1080, height: 1920, elements: [], _appMeta: {} });
}
