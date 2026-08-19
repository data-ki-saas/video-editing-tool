import { createClient } from "@/lib/supabase/client";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

async function authHeader(): Promise<HeadersInit> {
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

export type AssetKind = "video" | "image";

export interface Asset {
  id: string;
  project_id: string;
  uploaded_by: string;
  filename: string;
  kind: AssetKind;
  mime_type: "video/mp4" | "image/jpeg" | "image/png";
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
