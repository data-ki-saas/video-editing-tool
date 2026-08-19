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
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

interface RenderRequestBody {
  projectId: string;
  timeline: Record<string, unknown>;
}

function parseRequestBody(body: unknown): RenderRequestBody | null {
  if (typeof body !== "object" || body === null) return null;
  const { projectId, timeline } = body as Record<string, unknown>;
  if (typeof projectId !== "string" || !projectId) return null;
  if (typeof timeline !== "object" || timeline === null || Array.isArray(timeline)) return null;
  return { projectId, timeline: timeline as Record<string, unknown> };
}

/** Where Creatomate POSTs render completion/failure. This has to be the
 * backend (Render), not this Next.js app: Creatomate's callback carries no
 * Supabase user session, so updating the projects row requires the
 * service-role client -- which only exists in backend/, by design (see
 * README.md's "Asset URLs" section for the same reasoning applied to R2).
 * NOTE: the backend doesn't implement this receiver yet -- this only wires
 * up where it will live. */
function buildWebhookUrl(): string | null {
  const backendUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!backendUrl) return null;
  return `${backendUrl.replace(/\/$/, "")}/api/renders/webhook`;
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
    return NextResponse.json({ error: "projectId and timeline are required" }, { status: 400 });
  }
  const { projectId, timeline } = body;

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

  const apiKey = process.env.CREATOMATE_API_KEY;
  if (!apiKey) {
    console.error("[api/render] CREATOMATE_API_KEY is not set");
    return NextResponse.json({ error: "Render service is not configured" }, { status: 500 });
  }

  const webhookUrl = buildWebhookUrl();
  if (!webhookUrl) {
    console.error("[api/render] NEXT_PUBLIC_API_BASE_URL is not set -- cannot build a webhook URL");
    return NextResponse.json({ error: "Render service is not configured" }, { status: 500 });
  }

  try {
    const client = new Client(apiKey);

    // startRender() fires the job and returns immediately -- unlike
    // client.render(), which polls the API until the video finishes (up to
    // 15 minutes by default), which would blow well past this route's
    // execution limit. Creatomate notifies `webhookUrl` when it's done.
    const renders = await client.startRender({
      source: timeline,
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
      .update({ render_id: render.id, render_status: render.status })
      .eq("id", projectId)
      .eq("owner_id", user.id);

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
