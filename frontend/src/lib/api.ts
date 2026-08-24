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
