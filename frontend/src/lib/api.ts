import { createClient } from "@/lib/supabase/client";
import type { CompileTimelineInput } from "@/lib/timeline/compileCreatomateTimeline";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

async function authHeader(): Promise<Record<string, string>> {
  const supabase = createClient();
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Thin wrapper around fetch() that distinguishes a network-level failure
 * (CORS block, DNS/connection failure, offline -- fetch() rejects) from a
 * valid HTTP error response (fetch() resolves fine; handleResponse below
 * deals with that). Without this, both looked identical to the user: a
 * generic "Failed to fetch" with no indication it was a deployment/CORS
 * problem rather than something wrong with their upload. */
async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    console.error(`[api] network error calling ${input} (backend base URL: ${API_BASE_URL})`, err);
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not reach the API at ${API_BASE_URL} -- this usually means a CORS or network ` +
        `configuration issue, not a problem with your file. (${detail})`
    );
  }
}

/** FastAPI's `detail` is a plain string for a handler's own HTTPException,
 * but a *list* of {loc, msg, type} objects for a 422 Pydantic validation
 * error -- passing that array straight into `Error()` stringifies to an
 * unreadable "[object Object]" with no indication of what was wrong. */
function formatErrorDetail(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((entry) => {
      if (entry && typeof entry === "object" && "msg" in entry) {
        const field = Array.isArray(entry.loc) ? entry.loc.at(-1) : undefined;
        return field ? `${field}: ${entry.msg}` : String(entry.msg);
      }
      return String(entry);
    });
    return messages.join("; ") || undefined;
  }
  return undefined;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    console.error(`[api] request to ${response.url} failed: HTTP ${response.status}`, body);
    throw new Error(formatErrorDetail(body.detail) ?? `Request failed (HTTP ${response.status})`);
  }
  return response.json();
}

export type AssetKind = "video" | "image" | "audio";

export interface Asset {
  id: string;
  project_id: string;
  uploaded_by: string;
  filename: string;
  kind: AssetKind;
  mime_type: "video/mp4" | "image/jpeg" | "image/png" | "audio/mpeg";
  size_bytes: number;
  // A presigned R2 URL, valid for a limited time (see the backend's
  // R2_SIGNED_URL_EXPIRES_SECONDS) -- not a permanent link. Re-fetch the
  // asset (listAssets/uploadAsset) rather than caching this past expiry.
  url: string;
  created_at: string;
}

export async function uploadAsset(projectId: string, file: File) {
  const formData = new FormData();
  formData.append("file", file);

  const url = new URL(`${API_BASE_URL}/api/assets`);
  url.searchParams.set("project_id", projectId);

  const response = await apiFetch(url.toString(), {
    method: "POST",
    headers: await authHeader(),
    body: formData,
  });
  return handleResponse<Asset>(response);
}

/** Same upload as uploadAsset() above, but over XMLHttpRequest instead of
 * fetch() so onProgress can report real upload progress via xhr.upload's
 * progress event -- fetch() has no cross-browser-reliable way to observe
 * request body upload progress. Used by the Upload panel's progress bar. */
export function uploadAssetWithProgress(
  projectId: string,
  file: File,
  onProgress: (fraction: number) => void
): Promise<Asset> {
  return authHeader().then(
    (headers) =>
      new Promise<Asset>((resolve, reject) => {
        const url = new URL(`${API_BASE_URL}/api/assets`);
        url.searchParams.set("project_id", projectId);

        const formData = new FormData();
        formData.append("file", file);

        const xhr = new XMLHttpRequest();
        xhr.open("POST", url.toString());
        for (const [key, value] of Object.entries(headers)) {
          xhr.setRequestHeader(key, value);
        }

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };

        xhr.onload = () => {
          let body: { detail?: unknown } = {};
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            // Non-JSON response body -- fall through to the generic message below.
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(body as unknown as Asset);
          } else {
            console.error(`[api] upload to ${url} failed: HTTP ${xhr.status}`, body);
            reject(new Error(formatErrorDetail(body.detail) ?? `Request failed (HTTP ${xhr.status})`));
          }
        };

        xhr.onerror = () => {
          console.error(`[api] network error uploading to ${url} (backend base URL: ${API_BASE_URL})`);
          reject(
            new Error(
              `Could not reach the API at ${API_BASE_URL} -- this usually means a CORS or network ` +
                `configuration issue, not a problem with your file.`
            )
          );
        };

        xhr.send(formData);
      })
  );
}

export async function listAssets(projectId: string) {
  const url = new URL(`${API_BASE_URL}/api/assets`);
  url.searchParams.set("project_id", projectId);

  const response = await apiFetch(url.toString(), { headers: await authHeader() });
  return handleResponse<Asset[]>(response);
}

export async function deleteAsset(assetId: string) {
  const response = await apiFetch(`${API_BASE_URL}/api/assets/${encodeURIComponent(assetId)}`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(formatErrorDetail(body.detail) ?? `Request failed (HTTP ${response.status})`);
  }
}

export type StockMediaKind = "photo" | "video" | "music";

export interface StockSearchResult {
  id: string;
  kind: StockMediaKind;
  title: string;
  thumbnail_url: string;
  preview_url: string;
  duration_seconds: number | null;
  attribution: string;
  width: number | null;
  height: number | null;
}

export interface StockSearchResponse {
  results: StockSearchResult[];
  page: number;
  has_more: boolean;
}

export async function searchStockMedia(kind: StockMediaKind, query: string, page: number) {
  const url = new URL(`${API_BASE_URL}/api/stock-media/search`);
  url.searchParams.set("kind", kind);
  url.searchParams.set("query", query);
  url.searchParams.set("page", String(page));

  const response = await apiFetch(url.toString(), { headers: await authHeader() });
  return handleResponse<StockSearchResponse>(response);
}

export async function importStockAsset(
  projectId: string,
  kind: StockMediaKind,
  sourceId: string,
  filename: string
) {
  const response = await apiFetch(`${API_BASE_URL}/api/stock-media/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ project_id: projectId, kind, source_id: sourceId, filename }),
  });
  return handleResponse<Asset>(response);
}

export interface TtsWordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface TtsSynthesisResult {
  assetId: string;
  url: string;
  durationSeconds: number;
  wordTimings: TtsWordTiming[];
}

export interface TtsVoiceOption {
  id: string;
  label: string;
  locale: string;
  gender: string;
}

/** POST /api/tts/synthesize -- converts `text` to speech via the chosen
 * `voice`, returning the generated audio's own asset id (same private-
 * asset-then-presigned-URL pattern as every other asset -- see Asset.url's
 * own comment) plus exact per-word timings for karaoke-style captioning
 * (see video_math.ts's TtsOverlay). The wire response is snake_case
 * (asset_id/duration_seconds/word_timings/start_ms/end_ms, matching every
 * other backend field) -- converted to camelCase here, at the boundary,
 * since TtsOverlay/TtsWordTiming flow into CanvasPlayer's hot preview loop
 * where camelCase matches the rest of this codebase's TS (see TextOverlay's
 * own startTimeSeconds). `rate`/`pitch` are supported by the backend but
 * have no UI in TtsOverlayDialog yet (see its own module comment) -- omit
 * to default both to 0. */
export async function synthesizeTts(
  projectId: string,
  text: string,
  voice: string,
  rate?: number,
  pitch?: number
): Promise<TtsSynthesisResult> {
  const response = await apiFetch(`${API_BASE_URL}/api/tts/synthesize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({
      project_id: projectId,
      text,
      voice,
      ...(rate !== undefined ? { rate } : {}),
      ...(pitch !== undefined ? { pitch } : {}),
    }),
  });
  const body = await handleResponse<{
    asset_id: string;
    url: string;
    duration_seconds: number;
    word_timings: { word: string; start_ms: number; end_ms: number }[];
  }>(response);
  return {
    assetId: body.asset_id,
    url: body.url,
    durationSeconds: body.duration_seconds,
    wordTimings: body.word_timings.map((w) => ({ word: w.word, startMs: w.start_ms, endMs: w.end_ms })),
  };
}

/** GET /api/tts/voices -- the catalog of voices TtsOverlayDialog's own
 * <select> populates from, fetched fresh on mount rather than hardcoded. */
export async function listTtsVoices(): Promise<{ voices: TtsVoiceOption[] }> {
  const response = await apiFetch(`${API_BASE_URL}/api/tts/voices`, { headers: await authHeader() });
  return handleResponse<{ voices: TtsVoiceOption[] }>(response);
}

export type AvatarGenerationStatus = "waiting" | "completed" | "failed";

export interface AvatarGeneration {
  id: string;
  status: AvatarGenerationStatus;
  assetId: string | null;
  url: string | null;
  error: string | null;
}

/** POST /api/avatar/generate -- kicks off a talking-avatar video lip-synced
 * to an ALREADY-GENERATED narration audio asset (see synthesizeTts above;
 * the avatar provider never does its own text-to-speech here, only the
 * visual side). `avatarId` omitted falls back to the server's configured
 * default (see listAvatars below for picking one explicitly). Async:
 * returns immediately with status "waiting" -- poll getAvatarGeneration
 * below until it's terminal. */
export async function generateAvatarVideo(
  projectId: string,
  audioAssetId: string,
  avatarId?: string
): Promise<AvatarGeneration> {
  const response = await apiFetch(`${API_BASE_URL}/api/avatar/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({
      project_id: projectId,
      audio_asset_id: audioAssetId,
      ...(avatarId ? { avatar_id: avatarId } : {}),
    }),
  });
  const body = await handleResponse<{ id: string; status: AvatarGenerationStatus }>(response);
  return { id: body.id, status: body.status, assetId: null, url: null, error: null };
}

export interface AvatarOption {
  id: string;
  name: string;
  previewImageUrl: string | null;
  gender: string | null;
  preferredOrientation: string | null;
}

/** GET /api/avatar/avatars -- HeyGen's own preset-avatar catalog (names +
 * thumbnails), cached server-side for an hour (see avatar/service.py) so
 * this is cheap to call on every Review-step visit rather than something
 * that needs its own client-side caching too. */
export async function listAvatars(): Promise<{ avatars: AvatarOption[] }> {
  const response = await apiFetch(`${API_BASE_URL}/api/avatar/avatars`, { headers: await authHeader() });
  const body = await handleResponse<{
    avatars: { id: string; name: string; preview_image_url: string | null; gender: string | null; preferred_orientation: string | null }[];
  }>(response);
  return {
    avatars: body.avatars.map((a) => ({
      id: a.id,
      name: a.name,
      previewImageUrl: a.preview_image_url,
      gender: a.gender,
      preferredOrientation: a.preferred_orientation,
    })),
  };
}

/** GET /api/avatar/generations/{id} -- poll until status is "completed" or
 * "failed" (see dashboard/(chrome)/new/page.tsx's pollAvatarGeneration). */
export async function getAvatarGeneration(id: string): Promise<AvatarGeneration> {
  const response = await apiFetch(`${API_BASE_URL}/api/avatar/generations/${encodeURIComponent(id)}`, {
    headers: await authHeader(),
  });
  const body = await handleResponse<{
    id: string;
    status: AvatarGenerationStatus;
    asset_id: string | null;
    url: string | null;
    error: string | null;
  }>(response);
  return { id: body.id, status: body.status, assetId: body.asset_id, url: body.url, error: body.error };
}

export async function deleteProject(projectId: string) {
  const response = await apiFetch(`${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(formatErrorDetail(body.detail) ?? `Request failed (HTTP ${response.status})`);
  }
}

// Wipes a reel's assets and render state but keeps the row -- see
// backend's src/projects/service.py's reset_project for the R2 cleanup this
// does (mirrors delete_project's, minus deleting the row). Doesn't touch
// `timeline` itself; lib/projects.ts's resetProject does that other half
// via the normal saveTimeline path once this succeeds.
export async function resetProject(projectId: string) {
  const response = await apiFetch(`${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/reset`, {
    method: "POST",
    headers: await authHeader(),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(formatErrorDetail(body.detail) ?? `Request failed (HTTP ${response.status})`);
  }
}

export interface ThumbnailInfo {
  thumbnail_url: string;
  thumbnail_source: "frame" | "upload";
  thumbnail_time_seconds: number | null;
}

/** POST /api/projects/{id}/thumbnail -- backs both of CoverPicker's modes.
 * `source: "frame"` sends a JPEG blob captured client-side from
 * CanvasPlayer's own canvas (see CanvasPlayer.tsx's captureFrame) with
 * `timeSeconds` set to the playhead position it was captured at;
 * `source: "upload"` sends a user-picked image file with no `timeSeconds`.
 * Either way the backend writes a fresh R2 object and returns its
 * permanent public URL -- see projects/service.py's upload_thumbnail. */
export async function uploadThumbnail(
  projectId: string,
  file: File | Blob,
  source: "frame" | "upload",
  timeSeconds?: number
): Promise<ThumbnailInfo> {
  const formData = new FormData();
  formData.append("file", file, source === "frame" ? "cover.jpg" : (file as File).name);
  formData.append("source", source);
  if (timeSeconds !== undefined) formData.append("time_seconds", String(timeSeconds));

  const response = await apiFetch(`${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/thumbnail`, {
    method: "POST",
    headers: await authHeader(),
    body: formData,
  });
  return handleResponse<ThumbnailInfo>(response);
}

/** Clears a project's cover back to "no custom thumbnail" -- routed through
 * the backend (not a direct Supabase write) since it also deletes the R2
 * object, same reason deleteProject/resetProject are. */
export async function clearThumbnail(projectId: string) {
  const response = await apiFetch(`${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}/thumbnail`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(formatErrorDetail(body.detail) ?? `Request failed (HTTP ${response.status})`);
  }
}

export interface RenderTriggerResult {
  renderId: string;
  status: string;
  warning?: string;
}

/** Calls this Next.js app's own /api/render route (not the FastAPI
 * backend) -- same-origin, so no CORS/API_BASE_URL involved. That route
 * authenticates via the browser's Supabase cookie session directly, then
 * compiles `compileInput` into real Creatomate JSON itself (see
 * lib/timeline/compileCreatomateTimeline.ts's own comment on why that
 * can't happen here in the browser). */
export async function triggerRender(projectId: string, compileInput: CompileTimelineInput) {
  const response = await fetch("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId, compileInput }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Request failed (HTTP ${response.status})`);
  }
  return body as RenderTriggerResult;
}
