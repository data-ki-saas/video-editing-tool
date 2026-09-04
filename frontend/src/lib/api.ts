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

/** Thrown for a 403 shaped like backend/src/permissions/service.py's
 * feature_denied_detail -- lets a catch block distinguish "you're not
 * allowed to do this, upgrade to unlock it" from any other error, instead
 * of pattern-matching on a generic Error's message string. */
export class FeatureLockedError extends Error {
  readonly feature: string;
  readonly role: string;
  readonly roleLabel: string;
  readonly upgradeUrl?: string;

  constructor(detail: {
    feature: string;
    feature_label: string;
    role: string;
    role_label: string;
    message: string;
    upgrade_url?: string;
  }) {
    super(detail.message);
    this.name = "FeatureLockedError";
    this.feature = detail.feature;
    this.role = detail.role;
    this.roleLabel = detail.role_label;
    this.upgradeUrl = detail.upgrade_url;
  }
}

function isFeatureNotAllowedDetail(detail: unknown): detail is {
  code: "feature_not_allowed";
  feature: string;
  feature_label: string;
  role: string;
  role_label: string;
  message: string;
  upgrade_url?: string;
} {
  return Boolean(detail && typeof detail === "object" && (detail as { code?: unknown }).code === "feature_not_allowed");
}

/** Turns a non-ok response's parsed `detail` into the right Error to throw.
 * A structured "you need to upgrade" 403 becomes a FeatureLockedError; a
 * plain {message} object (e.g. role-delete-blocked's 409) surfaces that
 * message directly; anything else falls back to formatErrorDetail's
 * string/422-array handling. Shared by every throwing call site below so
 * this shape is recognized consistently instead of degrading to a generic
 * "Request failed (HTTP nnn)". */
function errorFromDetail(status: number, detail: unknown): Error {
  if (isFeatureNotAllowedDetail(detail)) return new FeatureLockedError(detail);
  if (detail && typeof detail === "object" && typeof (detail as { message?: unknown }).message === "string") {
    return new Error((detail as { message: string }).message);
  }
  return new Error(formatErrorDetail(detail) ?? `Request failed (HTTP ${status})`);
}

/** Throws (via errorFromDetail) if `response` isn't ok -- otherwise resolves
 * with no value. Shared by every call site that only cares about success/
 * failure, not a parsed body (deleteAsset, resetProject, clearThumbnail,
 * deleteRole, ...). */
async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.json().catch(() => ({}));
  console.error(`[api] request to ${response.url} failed: HTTP ${response.status}`, body);
  throw errorFromDetail(response.status, body.detail);
}

async function handleResponse<T>(response: Response): Promise<T> {
  await throwIfNotOk(response);
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
            reject(errorFromDetail(xhr.status, body.detail));
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
  await throwIfNotOk(response);
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

export type BackgroundRemovalStatus = "waiting" | "completed" | "failed";

export interface BackgroundRemoval {
  status: BackgroundRemovalStatus;
  matteAssetId: string | null;
  matteUrl: string | null;
  error: string | null;
}

/** POST /api/matting/request -- kicks off (or, if one already exists for
 * this exact clip/photo, simply returns) an AI background-removal job for
 * an already-uploaded asset. Keyed by sourceAssetId, not by cutaway/
 * segment: the same clip/photo reused across multiple cutaways shares one
 * job instead of paying for it again (see backend/src/matting/service.py's
 * own comment). A VIDEO job is async (returns "waiting" -- poll
 * getBackgroundRemoval below until terminal); a PHOTO job is synchronous
 * (backend/src/matting/service.py's image-kind path calls rembg directly),
 * so this often already returns "completed" with matteAssetId/matteUrl
 * populated -- callers should check for that before bothering to poll (see
 * lib/backgroundRemoval.ts's pollBackgroundRemoval, which already no-ops
 * immediately for a non-"waiting" status). */
export async function requestBackgroundRemoval(projectId: string, sourceAssetId: string): Promise<BackgroundRemoval> {
  const response = await apiFetch(`${API_BASE_URL}/api/matting/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ project_id: projectId, source_asset_id: sourceAssetId }),
  });
  const body = await handleResponse<{
    status: BackgroundRemovalStatus;
    matte_asset_id: string | null;
    matte_url: string | null;
    error: string | null;
  }>(response);
  return { status: body.status, matteAssetId: body.matte_asset_id, matteUrl: body.matte_url, error: body.error };
}

/** GET /api/matting/status/{sourceAssetId} -- poll until status is
 * "completed" or "failed" (see lib/backgroundRemoval.ts's
 * pollBackgroundRemoval). */
export async function getBackgroundRemoval(sourceAssetId: string): Promise<BackgroundRemoval> {
  const response = await apiFetch(`${API_BASE_URL}/api/matting/status/${encodeURIComponent(sourceAssetId)}`, {
    headers: await authHeader(),
  });
  const body = await handleResponse<{
    status: BackgroundRemovalStatus;
    matte_asset_id: string | null;
    matte_url: string | null;
    error: string | null;
  }>(response);
  return { status: body.status, matteAssetId: body.matte_asset_id, matteUrl: body.matte_url, error: body.error };
}

export interface UsageSummaryItem {
  eventType: string;
  label: string;
  count: number;
  limit: number;
}

/** GET /api/usage/summary -- current daily usage vs. cap for each
 * paywalled-style feature (render/voiceover/avatar_video), shown on
 * /account/usage. */
export async function getUsageSummary(): Promise<{ items: UsageSummaryItem[] }> {
  const response = await apiFetch(`${API_BASE_URL}/api/usage/summary`, { headers: await authHeader() });
  const body = await handleResponse<{
    items: { event_type: string; label: string; count: number; limit: number }[];
  }>(response);
  return {
    items: body.items.map((item) => ({
      eventType: item.event_type,
      label: item.label,
      count: item.count,
      limit: item.limit,
    })),
  };
}

export interface AdminUsageTotal {
  eventType: string;
  quantitySum: number;
  costEstimateCentsSum: number;
  count: number;
}

export interface AdminUsageDaily {
  date: string;
  costEstimateCents: number;
}

export interface AdminUsageTopUser {
  userId: string;
  email: string | null;
  costEstimateCentsSum: number;
}

export interface AdminUsageSummary {
  days: number;
  totals: AdminUsageTotal[];
  daily: AdminUsageDaily[];
  topUsers: AdminUsageTopUser[];
}

/** GET /api/metering/admin-summary -- cross-user cost/usage rollup for
 * /admin/usage, gated by the metering_admin_view feature. Distinct from
 * getUsageSummary above, which is a per-user guardrail widget backed by
 * usage_events, not usage_ledger. */
export async function getAdminUsageSummary(days: number): Promise<AdminUsageSummary> {
  const response = await apiFetch(`${API_BASE_URL}/api/metering/admin-summary?days=${encodeURIComponent(days)}`, {
    headers: await authHeader(),
  });
  const body = await handleResponse<{
    days: number;
    totals: { event_type: string; quantity_sum: number; cost_estimate_cents_sum: number; count: number }[];
    daily: { date: string; cost_estimate_cents: number }[];
    top_users: { user_id: string; email: string | null; cost_estimate_cents_sum: number }[];
  }>(response);
  return {
    days: body.days,
    totals: body.totals.map((t) => ({
      eventType: t.event_type,
      quantitySum: t.quantity_sum,
      costEstimateCentsSum: t.cost_estimate_cents_sum,
      count: t.count,
    })),
    daily: body.daily.map((d) => ({ date: d.date, costEstimateCents: d.cost_estimate_cents })),
    topUsers: body.top_users.map((u) => ({
      userId: u.user_id,
      email: u.email,
      costEstimateCentsSum: u.cost_estimate_cents_sum,
    })),
  };
}

export interface CapWarning {
  userId: string;
  email: string | null;
  feature: string;
  capValue: number;
  countAtTrigger: number;
  createdAt: string;
}

export interface CapWarningsResult {
  days: number;
  warnings: CapWarning[];
}

/** GET /api/metering/cap-warnings -- a log of daily-cap-exceeded events
 * (every non-admin request a user made after hitting their render/
 * voiceover/avatar/matting cap), gated by the same metering_admin_view
 * feature as getAdminUsageSummary. Backs /admin/usage's warning log panel
 * -- a possible cost-overrun signal an admin would otherwise only see by
 * digging through Render's server logs. */
export async function getCapWarnings(days: number): Promise<CapWarningsResult> {
  const response = await apiFetch(`${API_BASE_URL}/api/metering/cap-warnings?days=${encodeURIComponent(days)}`, {
    headers: await authHeader(),
  });
  const body = await handleResponse<{
    days: number;
    warnings: { user_id: string; email: string | null; feature: string; cap_value: number; count_at_trigger: number; created_at: string }[];
  }>(response);
  return {
    days: body.days,
    warnings: body.warnings.map((w) => ({
      userId: w.user_id,
      email: w.email,
      feature: w.feature,
      capValue: w.cap_value,
      countAtTrigger: w.count_at_trigger,
      createdAt: w.created_at,
    })),
  };
}

export async function deleteProject(projectId: string) {
  const response = await apiFetch(`${API_BASE_URL}/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  await throwIfNotOk(response);
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
  await throwIfNotOk(response);
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
  await throwIfNotOk(response);
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
    // The route forwards backend/src/permissions/router.py's /assert body
    // verbatim on a permission denial (see api/render/route.ts's own
    // comment) -- `body.detail` is that shape; every other error this route
    // returns is its own native `{error}` shape.
    if (isFeatureNotAllowedDetail(body.detail)) throw new FeatureLockedError(body.detail);
    throw new Error(body.error ?? `Request failed (HTTP ${response.status})`);
  }
  return body as RenderTriggerResult;
}

// --- Roles & permissions (backend/src/permissions/*) ---------------------

export interface FeatureInfo {
  key: string;
  label: string;
  group: string;
}

export interface MyPermissions {
  role: string;
  roleLabel: string;
  badgeColor: string;
  features: string[];
}

/** GET /api/permissions/me -- the signed-in user's own role + granted
 * feature keys, backing usePermissions().  */
export async function getMyPermissions(): Promise<MyPermissions> {
  const response = await apiFetch(`${API_BASE_URL}/api/permissions/me`, { headers: await authHeader() });
  const body = await handleResponse<{ role: string; role_label: string; badge_color: string; features: string[] }>(
    response
  );
  return { role: body.role, roleLabel: body.role_label, badgeColor: body.badge_color, features: body.features };
}

/** GET /api/permissions/features -- the full feature registry, for the
 * admin role-editor's checklist. */
export async function listFeatures(): Promise<FeatureInfo[]> {
  const response = await apiFetch(`${API_BASE_URL}/api/permissions/features`, { headers: await authHeader() });
  return handleResponse<FeatureInfo[]>(response);
}

export interface RoleInfo {
  key: string;
  displayName: string;
  description: string | null;
  isSystem: boolean;
  isDefault: boolean;
  badgeColor: string;
  userCount: number;
  features: string[];
}

interface RoleWire {
  key: string;
  display_name: string;
  description: string | null;
  is_system: boolean;
  is_default: boolean;
  badge_color: string;
  user_count: number;
  features: string[];
}

function roleFromWire(row: RoleWire): RoleInfo {
  return {
    key: row.key,
    displayName: row.display_name,
    description: row.description,
    isSystem: row.is_system,
    isDefault: row.is_default,
    badgeColor: row.badge_color,
    userCount: row.user_count,
    features: row.features,
  };
}

/** GET /api/roles -- admin-only (require_feature("admin_manage_roles")). */
export async function listRoles(): Promise<RoleInfo[]> {
  const response = await apiFetch(`${API_BASE_URL}/api/roles`, { headers: await authHeader() });
  const body = await handleResponse<RoleWire[]>(response);
  return body.map(roleFromWire);
}

export async function createRole(input: {
  key: string;
  displayName: string;
  description?: string;
  badgeColor?: string;
}): Promise<RoleInfo> {
  const response = await apiFetch(`${API_BASE_URL}/api/roles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({
      key: input.key,
      display_name: input.displayName,
      description: input.description,
      ...(input.badgeColor ? { badge_color: input.badgeColor } : {}),
    }),
  });
  return roleFromWire(await handleResponse<RoleWire>(response));
}

export async function updateRole(
  roleKey: string,
  input: { displayName?: string; description?: string; badgeColor?: string }
): Promise<RoleInfo> {
  const response = await apiFetch(`${API_BASE_URL}/api/roles/${encodeURIComponent(roleKey)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({
      ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.badgeColor !== undefined ? { badge_color: input.badgeColor } : {}),
    }),
  });
  return roleFromWire(await handleResponse<RoleWire>(response));
}

/** DELETE /api/roles/{key} -- 409s (via errorFromDetail's {message} branch)
 * if the role is a protected system role or still has users assigned. */
export async function deleteRole(roleKey: string): Promise<void> {
  const response = await apiFetch(`${API_BASE_URL}/api/roles/${encodeURIComponent(roleKey)}`, {
    method: "DELETE",
    headers: await authHeader(),
  });
  await throwIfNotOk(response);
}

export async function updateRoleFeatures(roleKey: string, features: string[]): Promise<RoleInfo> {
  const response = await apiFetch(`${API_BASE_URL}/api/roles/${encodeURIComponent(roleKey)}/features`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ features }),
  });
  return roleFromWire(await handleResponse<RoleWire>(response));
}

export interface AdminUserInfo {
  id: string;
  email: string | null;
  displayName: string | null;
  role: string;
  roleLabel: string;
  badgeColor: string;
}

interface AdminUserWire {
  id: string;
  email: string | null;
  display_name: string | null;
  role: string;
  role_label: string;
  badge_color: string;
}

function userFromWire(row: AdminUserWire): AdminUserInfo {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    roleLabel: row.role_label,
    badgeColor: row.badge_color,
  };
}

/** GET /api/users?search= -- email substring search across every signed-up
 * user (not just ones with a profiles row -- see permissions/repository.py's
 * list_users), for the admin user-role-assignment page. */
export async function listUsers(search?: string): Promise<AdminUserInfo[]> {
  const url = new URL(`${API_BASE_URL}/api/users`);
  if (search) url.searchParams.set("search", search);
  const response = await apiFetch(url.toString(), { headers: await authHeader() });
  const body = await handleResponse<{ users: AdminUserWire[] }>(response);
  return body.users.map(userFromWire);
}

export async function updateUserRole(userId: string, role: string): Promise<AdminUserInfo> {
  const response = await apiFetch(`${API_BASE_URL}/api/users/${encodeURIComponent(userId)}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ role }),
  });
  return userFromWire(await handleResponse<AdminUserWire>(response));
}

export interface LibraryVideo {
  id: string;
  projectId: string | null;
  projectName: string;
  videoUrl: string;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  isTemplate: boolean;
  createdAt: string;
}

interface LibraryVideoWire {
  id: string;
  project_id: string | null;
  project_name: string;
  video_url: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  is_template: boolean;
  created_at: string;
}

function libraryVideoFromWire(w: LibraryVideoWire): LibraryVideo {
  return {
    id: w.id,
    projectId: w.project_id,
    projectName: w.project_name,
    videoUrl: w.video_url,
    thumbnailUrl: w.thumbnail_url,
    durationSeconds: w.duration_seconds,
    isTemplate: w.is_template,
    createdAt: w.created_at,
  };
}

/** GET /api/library -- this user's saved reels, newest first (the backend
 * already orders by created_at desc via library_videos_user_time_idx). */
export async function listLibraryVideos(): Promise<LibraryVideo[]> {
  const response = await apiFetch(`${API_BASE_URL}/api/library`, { headers: await authHeader() });
  const body = await handleResponse<{ videos: LibraryVideoWire[] }>(response);
  return body.videos.map(libraryVideoFromWire);
}

/** POST /api/library (multipart) -- uploads a finished Edge Render (see
 * LocalRenderPopup.tsx's "Save to library" button) into the user's
 * permanent library. The local render's own blob: URL only lives as long
 * as that tab stays open, so this is the only way to keep one past that.
 * `thumbnail` is best-effort -- omit it (or let it fail server-side) and
 * the saved entry just shows no preview image. */
export async function saveToLibrary(params: {
  projectId: string;
  video: Blob;
  videoFilename: string;
  thumbnail: Blob | null;
  durationSeconds: number | null;
}): Promise<LibraryVideo> {
  const formData = new FormData();
  formData.append("project_id", params.projectId);
  if (params.durationSeconds != null && Number.isFinite(params.durationSeconds)) {
    formData.append("duration_seconds", String(params.durationSeconds));
  }
  formData.append("video", params.video, params.videoFilename);
  if (params.thumbnail) formData.append("thumbnail", params.thumbnail, "thumbnail.jpg");

  const response = await apiFetch(`${API_BASE_URL}/api/library`, {
    method: "POST",
    headers: await authHeader(),
    body: formData,
  });
  return libraryVideoFromWire(await handleResponse<LibraryVideoWire>(response));
}

/** PATCH /api/library/{id}/template -- the library page's "Save as
 * template" action button. A template IS a library video, just flagged
 * (see supabase/migrations/0023's own comment) -- toggling it back off
 * ("Remove from templates") is the same call with `isTemplate: false`. */
export async function setLibraryVideoTemplate(videoId: string, isTemplate: boolean): Promise<LibraryVideo> {
  const response = await apiFetch(`${API_BASE_URL}/api/library/${encodeURIComponent(videoId)}/template`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...(await authHeader()) },
    body: JSON.stringify({ is_template: isTemplate }),
  });
  return libraryVideoFromWire(await handleResponse<LibraryVideoWire>(response));
}

/** GET /api/library/public/{id} -- backs the public /share/[videoId] page.
 * Deliberately no auth header: this is the one library call meant to work
 * for a visitor with no account at all (or signed into a different one) --
 * see the backend's own get_public_video comment on why that's not a new
 * privacy exposure. */
export async function getPublicLibraryVideo(videoId: string): Promise<LibraryVideo> {
  const response = await apiFetch(`${API_BASE_URL}/api/library/public/${encodeURIComponent(videoId)}`);
  return libraryVideoFromWire(await handleResponse<LibraryVideoWire>(response));
}
