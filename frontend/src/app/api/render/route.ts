import { NextResponse } from "next/server";
import {
  BadRequestError,
  Client,
  ConnectionError,
  CreatomateError,
  InsufficientCreditsError,
  InvalidApiKeyError,
  RateLimitExceededError,
  TimeoutError,
} from "creatomate";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { compileCreatomateTimeline, type CompileTimelineInput } from "@/lib/timeline/compileCreatomateTimeline";

export const runtime = "nodejs";

// Abuse guardrail, not billing/metering -- a fixed daily cap per user,
// checked against usage_events (see supabase/migrations/0006). Easy to
// tune once real usage exists; not meant to model plans/tiers.
const RENDER_DAILY_LIMIT = 10;

interface RenderRequestBody {
  projectId: string;
  // Raw ingredients, not a pre-built Timeline -- the client only ever
  // gathers plain data (see lib/timeline/gatherRenderClips.ts); the actual
  // Creatomate JSON is compiled HERE, server-side, since
  // compileCreatomateTimeline.ts imports the `creatomate` package itself
  // (Node-only -- see that file's own module comment) and could never run
  // in the browser.
  compileInput: CompileTimelineInput;
}

function parseRequestBody(body: unknown): RenderRequestBody | null {
  if (typeof body !== "object" || body === null) return null;
  const { projectId, compileInput } = body as Record<string, unknown>;
  if (typeof projectId !== "string" || !projectId) return null;
  if (typeof compileInput !== "object" || compileInput === null || Array.isArray(compileInput)) return null;
  return { projectId, compileInput: compileInput as CompileTimelineInput };
}

/** Where Creatomate POSTs render completion/failure -- see
 * app/api/webhooks/creatomate/route.ts. Creatomate doesn't support signed
 * webhooks, so `secret` in the query string IS the security boundary the
 * receiver checks; treat CREATOMATE_WEBHOOK_SECRET like an API key. */
function buildWebhookUrl(): string | null {
  const siteUrl = process.env.SITE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  const secret = process.env.CREATOMATE_WEBHOOK_SECRET;
  if (!siteUrl || !secret) return null;

  const url = new URL("/api/webhooks/creatomate", siteUrl);
  url.searchParams.set("secret", secret);
  return url.toString();
}

/** A signed-in-but-not-yet-abusive check: counts this user's renders in the
 * last 24h against a fixed cap. Fails OPEN on a read error -- a usage_events
 * hiccup shouldn't block the render feature entirely. */
async function isUnderRenderRateLimit(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from("usage_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("event_type", "render")
    .gte("created_at", since);

  if (error) {
    console.error("[api/render] failed to check render rate limit", error);
    return true;
  }
  return (count ?? 0) < RENDER_DAILY_LIMIT;
}

/** The persisted timeline never contains a real playable URL -- only
 * `_appMeta[id].assetId` references (see lib/timeline/resolve.ts and
 * supabase/migrations/0004's comment on why: assets are private, presigned
 * URLs expire, so a URL saved into the DB would be dead by render time).
 * This is the server-side half of that design: resolve every referenced
 * asset to a FRESH presigned URL, by asking the backend (which holds the
 * R2 credentials), right before handing the compiled elements to
 * Creatomate. Never persisted -- only ever used for this one render call. */
async function resolveAssetSources(
  timeline: Record<string, unknown>,
  projectId: string,
  accessToken: string
): Promise<Record<string, unknown>> {
  const appMeta = (timeline._appMeta ?? {}) as Record<string, { assetId?: string }>;
  const assetIds = new Set(Object.values(appMeta).map((meta) => meta.assetId).filter(Boolean));
  if (assetIds.size === 0) return timeline;

  const backendUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!backendUrl) throw new Error("NEXT_PUBLIC_API_BASE_URL is not set");

  const url = new URL(`${backendUrl.replace(/\/$/, "")}/api/assets`);
  url.searchParams.set("project_id", projectId);
  const response = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    throw new Error(`Failed to resolve asset URLs for render (HTTP ${response.status})`);
  }
  const assets = (await response.json()) as Array<{ id: string; url: string }>;
  const urlByAssetId = new Map(assets.map((asset) => [asset.id, asset.url]));

  const elements = Array.isArray(timeline.elements) ? (timeline.elements as Array<Record<string, unknown>>) : [];
  const resolvedElements = elements.map((el) => {
    const elementId = el.id as string | undefined;
    const assetId = elementId ? appMeta[elementId]?.assetId : undefined;
    if (!assetId) return el;
    const resolvedUrl = urlByAssetId.get(assetId);
    return resolvedUrl ? { ...el, source: resolvedUrl } : el;
  });

  return { ...timeline, elements: resolvedElements };
}

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const body = parseRequestBody(rawBody);
  if (!body) {
    return NextResponse.json({ error: "projectId and compileInput are required" }, { status: 400 });
  }
  const { projectId, compileInput } = body;

  const supabase = await createClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // RLS already scopes `select` to the caller's own rows (see the "Users can
  // view their own projects" policy in supabase/migrations), but the
  // explicit owner_id filter is kept for the same reason the backend's
  // repository layer always filters explicitly: it stays correct even if
  // this client is ever swapped for a privileged one later.
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("owner_id", user.id)
    .maybeSingle();

  if (projectError) {
    console.error("[api/render] failed to look up project", projectId, projectError);
    return NextResponse.json({ error: "Failed to look up project" }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  if (!(await isUnderRenderRateLimit(supabase, user.id))) {
    return NextResponse.json(
      { error: `You've reached the limit of ${RENDER_DAILY_LIMIT} renders per day. Try again tomorrow.` },
      { status: 429 }
    );
  }

  const apiKey = process.env.CREATOMATE_API_KEY;
  if (!apiKey) {
    console.error("[api/render] CREATOMATE_API_KEY is not set");
    return NextResponse.json({ error: "Render service is not configured" }, { status: 500 });
  }

  const webhookUrl = buildWebhookUrl();
  if (!webhookUrl) {
    console.error("[api/render] SITE_URL/VERCEL_URL or CREATOMATE_WEBHOOK_SECRET is not set");
    return NextResponse.json({ error: "Render service is not configured" }, { status: 500 });
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // The permission source of truth lives entirely in the backend (roles +
  // role_features -- see supabase/migrations/0015 and
  // backend/src/permissions/), not queried directly from here, so this
  // logic and its "upgrade" copy exist in one language. Fails CLOSED (a
  // network error or non-2xx blocks the render) -- the opposite of this
  // route's own render-rate-limit check above, which fails open, since this
  // gates access rather than abuse.
  const backendUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  try {
    if (!backendUrl) throw new Error("NEXT_PUBLIC_API_BASE_URL is not set");
    const assertRes = await fetch(`${backendUrl.replace(/\/$/, "")}/api/permissions/assert`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ feature: "render_generate" }),
    });
    if (!assertRes.ok) {
      const body = await assertRes.json().catch(() => ({ error: "Render is not allowed for your account" }));
      return NextResponse.json(body, { status: assertRes.status });
    }
  } catch (err) {
    console.error("[api/render] failed to check render permission", projectId, err);
    return NextResponse.json({ error: "Could not verify render permission -- try again shortly" }, { status: 503 });
  }

  let timeline: ReturnType<typeof compileCreatomateTimeline>;
  try {
    timeline = compileCreatomateTimeline(compileInput);
  } catch (err) {
    console.error("[api/render] failed to compile timeline", projectId, err);
    return NextResponse.json({ error: "Failed to prepare this reel for render" }, { status: 400 });
  }

  let resolvedTimeline: Record<string, unknown>;
  try {
    resolvedTimeline = await resolveAssetSources(timeline as unknown as Record<string, unknown>, projectId, session.access_token);
  } catch (err) {
    console.error("[api/render] failed to resolve asset URLs", projectId, err);
    return NextResponse.json({ error: "Failed to resolve one or more assets for this render" }, { status: 502 });
  }

  try {
    const client = new Client(apiKey);

    // startRender() fires the job and returns immediately -- unlike
    // client.render(), which polls the API until the video finishes (up to
    // 15 minutes by default), which would blow well past this route's
    // execution limit. Creatomate notifies `webhookUrl` when it's done.
    const renders = await client.startRender({
      source: resolvedTimeline,
      outputFormat: "mp4",
      webhookUrl,
      // Lets the (session-less) webhook receiver find the right project
      // without an extra lookup table.
      metadata: projectId,
    });

    const render = renders[0];
    if (!render) {
      console.error("[api/render] Creatomate returned no render for project", projectId);
      return NextResponse.json({ error: "Render service returned no render job" }, { status: 502 });
    }

    const { error: updateError } = await supabase
      .from("projects")
      .update({
        render_id: render.id,
        render_status: render.status,
        render_started_at: new Date().toISOString(),
        render_error: null,
      })
      .eq("id", projectId)
      .eq("owner_id", user.id);

    // Best-effort usage record for the rate-limit check above -- a failure
    // here shouldn't fail a render that already started.
    const { error: usageError } = await supabase
      .from("usage_events")
      .insert({ user_id: user.id, event_type: "render" });
    if (usageError) {
      console.error("[api/render] failed to record usage event", projectId, usageError);
    }

    if (updateError) {
      // The render is already running at Creatomate -- there's no undoing
      // that, so a tracking-write failure is reported as a warning alongside
      // a 202, not turned into a 500. The webhook will still arrive; only
      // this app's own status column is stale until the next save/retry.
      console.error("[api/render] render started but failed to persist render_id", projectId, updateError);
      return NextResponse.json(
        {
          renderId: render.id,
          status: render.status,
          warning: "Render started, but saving its tracking status failed.",
        },
        { status: 202 }
      );
    }

    return NextResponse.json({ renderId: render.id, status: render.status }, { status: 202 });
  } catch (err) {
    console.error("[api/render] Creatomate render failed for project", projectId, err);

    if (err instanceof BadRequestError) {
      return NextResponse.json(
        { error: `Invalid timeline: ${err.message || "bad request"}` },
        { status: 400 }
      );
    }
    if (err instanceof InvalidApiKeyError) {
      // Never tell the caller it's specifically a bad API key.
      return NextResponse.json({ error: "Render service is not configured" }, { status: 500 });
    }
    if (err instanceof InsufficientCreditsError) {
      return NextResponse.json({ error: "Render account is out of credits" }, { status: 402 });
    }
    if (err instanceof RateLimitExceededError) {
      return NextResponse.json(
        { error: "Render service is rate-limited, try again shortly" },
        { status: 429 }
      );
    }
    if (err instanceof ConnectionError || err instanceof TimeoutError) {
      return NextResponse.json({ error: "Could not reach the render service" }, { status: 504 });
    }
    if (err instanceof CreatomateError) {
      return NextResponse.json({ error: err.message || "Render service error" }, { status: 502 });
    }

    return NextResponse.json({ error: "Unexpected error triggering render" }, { status: 500 });
  }
}
