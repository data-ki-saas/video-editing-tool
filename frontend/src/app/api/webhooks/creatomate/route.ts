import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/serviceRole";

type ServiceRoleClient = ReturnType<typeof createServiceRoleClient>;

export const runtime = "nodejs";

/** Creatomate doesn't publish an HMAC-signature scheme for webhooks (nothing
 * in their Node SDK source, nothing in their public docs as of writing) --
 * unlike Stripe/GitHub-style signed webhooks, there's no header to verify
 * here. Instead, `webhook_url` itself carries a `secret` query param we
 * generated and only we and Creatomate ever see (see
 * app/api/render/route.ts's buildWebhookUrl()). That's the actual security
 * boundary: treat CREATOMATE_WEBHOOK_SECRET as sensitive as an API key, and
 * rotate it if this URL is ever logged somewhere it shouldn't be. */
function hasValidSecret(request: Request): boolean {
  const expected = process.env.CREATOMATE_WEBHOOK_SECRET;
  if (!expected) return false;

  const provided = new URL(request.url).searchParams.get("secret") ?? "";
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

/** Fields as documented for Creatomate's render object (REST API, snake_case
 * on the wire -- their Node SDK only converts to camelCase for its own
 * method return values, not for this raw webhook body). NOTE: not verified
 * against a live payload -- confirm field names with a real webhook delivery
 * (Creatomate's dashboard logs recent deliveries) before relying on this in
 * production, and adjust extractPayload() below if any differ. */
interface CreatomatePayload {
  id: string;
  status: string;
  url?: string;
  snapshot_url?: string;
  error_message?: string;
  metadata?: string;
}

function extractPayload(body: unknown): CreatomatePayload | null {
  if (typeof body !== "object" || body === null) return null;
  const { id, status, url, snapshot_url, error_message, metadata } = body as Record<string, unknown>;
  if (typeof id !== "string" || typeof status !== "string") return null;
  return {
    id,
    status,
    url: typeof url === "string" ? url : undefined,
    snapshot_url: typeof snapshot_url === "string" ? snapshot_url : undefined,
    error_message: typeof error_message === "string" ? error_message : undefined,
    metadata: typeof metadata === "string" ? metadata : undefined,
  };
}

// Mirrors backend/src/core/config.py's creatomate_cost_cents_per_second --
// keep both in sync by hand, same precedent as RENDER_DAILY_LIMIT/
// render_daily_cap.
const CREATOMATE_COST_CENTS_PER_SECOND = 2.5;

/** Best-effort, same "a failure here shouldn't undo work already done"
 * posture as every other usage-recording call site in this app. Writes to
 * usage_ledger (see supabase/migrations/0016) -- the metering/billing-basis
 * table, distinct from usage_events' abuse-guardrail counter. */
async function recordUsageLedgerEvent(
  supabase: ServiceRoleClient,
  event: {
    userId: string;
    projectId: string;
    externalRef: string;
    quantitySeconds: number | null;
    status: "succeeded" | "failed";
  }
): Promise<void> {
  const quantity = event.quantitySeconds ?? 0;
  const { error } = await supabase.from("usage_ledger").insert({
    user_id: event.userId,
    project_id: event.projectId,
    event_type: "render",
    provider: "creatomate",
    external_ref: event.externalRef,
    quantity,
    unit: "seconds",
    cost_estimate_cents: event.status === "succeeded" ? quantity * CREATOMATE_COST_CENTS_PER_SECOND : 0,
    status: event.status,
  });
  if (error) {
    console.error("[webhooks/creatomate] failed to record usage ledger event", event.projectId, event.externalRef, error);
  }
}

const NOTIFY_WORKER_MAX_ATTEMPTS = 3;
const NOTIFY_WORKER_RETRY_DELAY_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Marks a render 'failed' with a specific reason -- used when this route
 * can't even hand the job off to the worker (below). worker/src/server.js
 * has its own equivalent for when the R2 mirror step itself exhausts its
 * retries after the worker HAS accepted the job. Without either of these,
 * both failure modes left render_status stuck at its prior value forever,
 * with zero indication anything went wrong. */
async function markTransferFailed(
  supabase: ServiceRoleClient,
  projectId: string,
  renderId: string,
  message: string
): Promise<void> {
  console.error("[webhooks/creatomate] marking render failed", projectId, renderId, message);
  const { error } = await supabase
    .from("projects")
    .update({ render_status: "failed", render_error: message })
    .eq("id", projectId)
    .eq("render_id", renderId);
  if (error) {
    console.error("[webhooks/creatomate] failed to record transfer failure", projectId, renderId, error);
  }
}

/** Hands the finished render off to the transfer worker (see worker/) so the
 * MP4 gets mirrored into R2 and served from our own Cloudflare-fronted
 * domain instead of Creatomate's temporary hosted URL. Deliberately NOT
 * awaited by the caller beyond firing the request -- streaming a
 * multi-hundred-MB video is well outside what should happen inside this
 * webhook's own execution window, and the worker updates render_status to
 * 'completed' itself once it's done.
 *
 * Retries a few times before giving up, since this is the ONE handoff point
 * between "Creatomate finished" and "the worker is on it" -- if it silently
 * failed here (worker down, transient network blip), nothing else would ever
 * pick the render back up, and it would sit at 'succeeded' forever with no
 * explanation. This does NOT cover the worker itself failing mid-transfer
 * after accepting the job -- that's handled worker-side. */
async function notifyTransferWorker(
  supabase: ServiceRoleClient,
  projectId: string,
  renderId: string,
  sourceUrl: string
): Promise<void> {
  const workerUrl = process.env.RENDER_WORKER_URL;
  const workerSecret = process.env.WORKER_INTERNAL_SECRET;
  if (!workerUrl || !workerSecret) {
    const message = "The render-transfer worker is not configured (RENDER_WORKER_URL/WORKER_INTERNAL_SECRET unset).";
    console.error("[webhooks/creatomate]", message);
    await markTransferFailed(supabase, projectId, renderId, message);
    return;
  }

  let lastError = "unknown error";
  for (let attempt = 1; attempt <= NOTIFY_WORKER_MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(workerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": workerSecret },
        body: JSON.stringify({ projectId, renderId, sourceUrl }),
      });
      if (response.ok) return; // worker accepted the job -- it owns render_status from here on
      lastError = `transfer worker responded with HTTP ${response.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    console.error(
      `[webhooks/creatomate] attempt ${attempt}/${NOTIFY_WORKER_MAX_ATTEMPTS} to notify transfer worker failed`,
      renderId,
      lastError
    );
    if (attempt < NOTIFY_WORKER_MAX_ATTEMPTS) await delay(NOTIFY_WORKER_RETRY_DELAY_MS * attempt);
  }

  await markTransferFailed(
    supabase,
    projectId,
    renderId,
    `Could not hand the finished render off to the transfer worker after ${NOTIFY_WORKER_MAX_ATTEMPTS} attempts: ${lastError}`
  );
}

export async function POST(request: Request) {
  if (!hasValidSecret(request)) {
    return NextResponse.json({ error: "Invalid webhook secret" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const payload = extractPayload(rawBody);
  if (!payload) {
    console.error("[webhooks/creatomate] unrecognized payload shape", rawBody);
    return NextResponse.json({ error: "Unrecognized payload" }, { status: 400 });
  }

  const { id: renderId, status, metadata: projectId } = payload;
  if (!projectId) {
    // metadata is set to projectId at trigger time (see app/api/render's
    // startRender call) -- a render with none can't be matched to a row.
    console.error("[webhooks/creatomate] render has no metadata/projectId", renderId);
    return NextResponse.json({ error: "Missing metadata" }, { status: 400 });
  }

  if (status === "failed") {
    console.error("[webhooks/creatomate] render failed", projectId, renderId, payload.error_message);
  }

  const supabase = createServiceRoleClient();

  // Creatomate's own status ('succeeded'/'failed') is stored as-is, as an
  // interim value -- distinct from our app-level 'completed', which the
  // transfer worker sets only once the MP4 is actually mirrored into R2.
  // Until then, render_url points at Creatomate's (temporary) URL so
  // there's still SOMETHING playable if the mirror step is slow or fails.
  const dbStatus = status;
  const finalCreatomateUrl = payload.url ?? payload.snapshot_url ?? null;
  const dbError = dbStatus === "failed" ? payload.error_message ?? "Render failed for an unspecified reason" : null;

  const { data, error } = await supabase
    .from("projects")
    .update({ render_status: dbStatus, render_url: finalCreatomateUrl, render_error: dbError })
    .eq("id", projectId)
    .eq("render_id", renderId)
    .select("id, owner_id, render_output_duration_seconds")
    .maybeSingle();

  if (error) {
    // A transient DB error is worth a retry -- Creatomate's webhook delivery
    // presumably retries on non-2xx, so surface this as one.
    console.error("[webhooks/creatomate] failed to update project", projectId, renderId, error);
    return NextResponse.json({ error: "Failed to persist render status" }, { status: 500 });
  }
  if (!data) {
    // No row matched (projectId, render_id) together -- a stale/replayed
    // delivery, or the render_id changed since. Retrying won't fix this, so
    // acknowledge with 2xx rather than inviting a retry storm.
    console.warn("[webhooks/creatomate] no matching project for render", projectId, renderId);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  if (dbStatus === "succeeded" || dbStatus === "failed") {
    void recordUsageLedgerEvent(supabase, {
      userId: data.owner_id,
      projectId,
      externalRef: renderId,
      quantitySeconds: data.render_output_duration_seconds,
      status: dbStatus,
    });
  }

  if (dbStatus === "succeeded" && finalCreatomateUrl) {
    void notifyTransferWorker(supabase, projectId, renderId, finalCreatomateUrl);
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
