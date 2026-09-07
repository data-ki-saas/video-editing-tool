"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useIsAdmin } from "@/lib/useIsAdmin";

// Static reference page -- no DB table, no CRUD. Pricing/plan details for
// third-party integrations change on their own schedule, not ours, so this
// is a hand-maintained log rather than an admin-editable form: add a dated
// entry to an integration's `log` array below when something changes
// (a price change, a plan swap, a quota bump) instead of overwriting the
// previous line.
type LogEntry = { date: string; note: string };

// `scope` is which of this app's TWO deployed services (Render backend,
// Vercel frontend) actually reads the variable at runtime -- see DEPLOY.md's
// own per-service tables, which this mirrors. Not every integration lives on
// the backend by default: Creatomate's own secret key is deliberately a
// FRONTEND (Vercel) env var (see root CLAUDE.md's stated exception for
// why), and Supabase's service-role key is needed on BOTH, so an
// integration can list vars under either or both scopes.
type EnvVar = { name: string; scope: "frontend" | "backend"; required: boolean };

type Integration = {
  name: string;
  purpose: string;
  pricingNote: string;
  docsUrl?: string;
  // Empty for a hosting platform (Render/Vercel themselves) that has no
  // app-level credential of its own to configure -- deploying TO it is the
  // whole integration.
  envVars: EnvVar[];
  log: LogEntry[];
};

const INTEGRATIONS: Integration[] = [
  {
    name: "Creatomate",
    purpose: "Server-side video rendering (final reel export) and the browser Preview SDK used by the editor.",
    pricingNote: "Paid SaaS, credit/render-minute based. No self-hosted fallback -- see DEPLOY.md step 3.",
    docsUrl: "https://creatomate.com/pricing",
    // Deliberately FRONTEND (Vercel), not backend -- see root CLAUDE.md's
    // stated exception for app/api/render/route.ts. The one integration on
    // this whole page where that's true.
    envVars: [
      { name: "CREATOMATE_API_KEY", scope: "frontend", required: true },
      { name: "CREATOMATE_WEBHOOK_SECRET", scope: "frontend", required: true },
      { name: "NEXT_PUBLIC_CREATOMATE_PUBLIC_TOKEN", scope: "frontend", required: true },
    ],
    log: [
      { date: "2026-08-24", note: "Chosen over self-hosted ffmpeg rendering -- see project memory \"Render backend decision\"." },
    ],
  },
  {
    name: "DeepSeek",
    purpose: "Default LLM provider -- powers niche-config generation (New Reel form fields + voiceover script template).",
    pricingNote: "Pay-per-token API. Swappable for Anthropic via LLM_PROVIDER=anthropic (see backend/src/llm/).",
    docsUrl: "https://platform.deepseek.com",
    envVars: [
      { name: "DEEPSEEK_API_KEY", scope: "backend", required: true },
      { name: "LLM_PROVIDER", scope: "backend", required: false },
      { name: "DEEPSEEK_MODEL", scope: "backend", required: false },
    ],
    log: [],
  },
  {
    name: "HeyGen",
    purpose: "Talking-avatar video generation for the voiceover step's optional \"Deliver as a talking avatar video\" feature.",
    pricingNote: "Pay-as-you-go, no free tier as of writing. Roughly $0.02-0.07/sec of avatar video -- keep AVATAR_DAILY_CAP small.",
    docsUrl: "https://app.heygen.com",
    envVars: [
      { name: "HEYGEN_API_KEY", scope: "backend", required: true },
      { name: "HEYGEN_DEFAULT_AVATAR_ID", scope: "backend", required: true },
      { name: "HEYGEN_WEBHOOK_SECRET", scope: "backend", required: true },
      { name: "BACKEND_PUBLIC_URL", scope: "backend", required: true },
      { name: "AVATAR_DAILY_CAP", scope: "backend", required: false },
    ],
    log: [],
  },
  {
    name: "VEED + rembg (via fal.ai)",
    purpose:
      "AI background removal for cutaways/compositing -- the editor's \"Remove background\" toggle. VEED's video background-removal model (fast, no edge-refinement tier) handles a video cutaway; a completely different fal-hosted model, fal-ai/imageutils/rembg, handles a Ken Burns photo cutaway -- both billed through the same fal.ai account/API key (FAL_API_KEY), not two separate vendor relationships.",
    pricingNote:
      "Pay-per-use, no subscription. VEED: $0.008/sec of video (fast tier, no edge refinement) -- a typical 3-8s cutaway costs $0.024-$0.064. rembg: ~$0.0011/compute-second per image (a rough per-image placeholder is used for the usage-ledger estimate -- see core/config.py's rembg_cost_cents_per_image, not a real measured rate). Chosen over cheaper per-second video options (e.g. Bria at $0.0042/sec) because VEED's dual H264 output (separate RGB + grayscale-matte streams) maps directly onto Creatomate's real maskMode: \"luma\" with no extra transcode step -- see project memory on the provider comparison.",
    docsUrl: "https://fal.ai/models/veed/video-background-removal/fast",
    envVars: [
      { name: "FAL_API_KEY", scope: "backend", required: true },
      // Video only -- rembg's own image-kind job is synchronous (see
      // matting/service.py's own comment), no webhook/callback URL needed.
      { name: "FAL_WEBHOOK_SECRET", scope: "backend", required: true },
      { name: "BACKEND_PUBLIC_URL", scope: "backend", required: true },
      { name: "MATTING_DAILY_CAP", scope: "backend", required: false },
    ],
    log: [
      {
        date: "2026-08-31",
        note: "Added -- VEED (video) first, rembg (Ken Burns photo cutaways) added same week. See backend/src/matting/ and compileCreatomateTimeline.ts's buildBackgroundRemovedSegment/buildBackgroundRemovedImageSegment.",
      },
    ],
  },
  {
    name: "Cloudflare R2",
    purpose: "Object storage -- private uploads bucket + public CDN-fronted finished-renders bucket.",
    pricingNote: "Usage-based storage, zero egress fees (the reason it was picked over S3 for the public renders bucket).",
    docsUrl: "https://developers.cloudflare.com/r2/pricing/",
    // Backend-only from THIS app's own perspective -- the render-transfer
    // worker (a separate deployed service, neither "frontend" nor
    // "backend" here) holds its own copy of the renders-bucket credentials
    // too (see DEPLOY.md step 5), not shown on this page.
    envVars: [
      { name: "R2_ACCOUNT_ID", scope: "backend", required: true },
      { name: "R2_ACCESS_KEY_ID", scope: "backend", required: true },
      { name: "R2_SECRET_ACCESS_KEY", scope: "backend", required: true },
      { name: "R2_BUCKET_NAME", scope: "backend", required: true },
      { name: "R2_RENDERS_ACCESS_KEY_ID", scope: "backend", required: true },
      { name: "R2_RENDERS_SECRET_ACCESS_KEY", scope: "backend", required: true },
      { name: "R2_RENDERS_BUCKET_NAME", scope: "backend", required: true },
      { name: "R2_RENDERS_PUBLIC_URL", scope: "backend", required: false },
      { name: "R2_SIGNED_URL_EXPIRES_SECONDS", scope: "backend", required: false },
    ],
    log: [],
  },
  {
    name: "Supabase",
    purpose: "Postgres database + Auth.",
    pricingNote: "Free tier in POC phase; check project usage before scaling.",
    docsUrl: "https://supabase.com/pricing",
    // The service-role key is needed on BOTH sides -- backend for every
    // normal DB read/write, frontend because
    // app/api/webhooks/creatomate/route.ts writes the finished render's
    // status straight from a Next.js API route (the OTHER stated exception
    // in root CLAUDE.md, alongside Creatomate's own key above).
    envVars: [
      { name: "SUPABASE_URL", scope: "backend", required: true },
      { name: "SUPABASE_SERVICE_ROLE_KEY", scope: "backend", required: true },
      { name: "NEXT_PUBLIC_SUPABASE_URL", scope: "frontend", required: true },
      { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", scope: "frontend", required: true },
      { name: "SUPABASE_SERVICE_ROLE_KEY", scope: "frontend", required: true },
    ],
    log: [],
  },
  {
    name: "Render",
    purpose: "Hosts the FastAPI backend and the render-transfer worker.",
    pricingNote: "Free tier spins down when idle (cold starts up to 30-60s) -- see DEPLOY.md pitfall #9.",
    docsUrl: "https://render.com/pricing",
    // The hosting platform itself -- no credential of its own to configure
    // inside this app; deploying a service TO it is the whole integration.
    envVars: [],
    log: [],
  },
  {
    name: "Vercel",
    purpose: "Hosts the Next.js frontend, including the render-trigger and Creatomate-webhook API routes.",
    pricingNote: "Free tier in POC phase.",
    docsUrl: "https://vercel.com/pricing",
    envVars: [],
    log: [],
  },
  {
    name: "Pexels",
    purpose: "Stock photo/video search in the editor. Optional -- disabled without PEXELS_API_KEY.",
    pricingNote: "Free API.",
    docsUrl: "https://www.pexels.com/api/",
    envVars: [{ name: "PEXELS_API_KEY", scope: "backend", required: false }],
    log: [],
  },
  {
    name: "Freesound",
    purpose: "Stock music search in the editor. Optional -- disabled without FREESOUND_API_KEY.",
    pricingNote: "Free API (basic token auth).",
    docsUrl: "https://freesound.org/apiv2/apply/",
    envVars: [{ name: "FREESOUND_API_KEY", scope: "backend", required: false }],
    log: [],
  },
];

export default function AdminIntegrationsPage() {
  const router = useRouter();
  const isAdmin = useIsAdmin();

  useEffect(() => {
    if (isAdmin === false) router.replace("/dashboard");
  }, [isAdmin, router]);

  if (isAdmin !== true) return null;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-12">
      <div>
        <Link href="/admin" className="text-sm text-muted hover:underline">
          ← Admin
        </Link>
        <h1 className="text-2xl font-semibold">Third-party integrations</h1>
        <p className="text-sm text-muted">
          Reference info only -- pricing and plan notes, which env vars each
          integration needs (and on which of this app&apos;s two deployed
          services, Render backend or Vercel frontend -- see DEPLOY.md for
          the full setup steps), plus a dated log per integration. Update
          this file directly when something changes; a trailing{" "}
          <code className="font-mono">?</code> marks an optional variable.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {INTEGRATIONS.map((integration) => (
          <div key={integration.name} className="rounded-md border border-border p-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="font-medium">{integration.name}</h2>
              {integration.docsUrl && (
                <a
                  href={integration.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-muted hover:underline"
                >
                  Pricing / docs ↗
                </a>
              )}
            </div>
            <p className="mt-1 text-sm text-muted">{integration.purpose}</p>
            <p className="mt-2 text-sm">{integration.pricingNote}</p>
            {integration.envVars.length > 0 && (
              <div className="mt-3 flex flex-col gap-1.5 border-t border-border pt-2">
                {(["backend", "frontend"] as const).map((scope) => {
                  const vars = integration.envVars.filter((v) => v.scope === scope);
                  if (vars.length === 0) return null;
                  return (
                    <div key={scope} className="flex flex-wrap items-baseline gap-1.5 text-xs">
                      <span className="w-16 shrink-0 text-muted">{scope === "backend" ? "Backend:" : "Frontend:"}</span>
                      {vars.map((v) => (
                        <code
                          key={v.name}
                          title={v.required ? "Required" : "Optional"}
                          className={"rounded-sm px-1 py-0.5 font-mono " + (v.required ? "bg-neutral-500/20" : "bg-neutral-500/10 text-muted")}
                        >
                          {v.name}
                          {!v.required && "?"}
                        </code>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
            {integration.log.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1 border-t border-border pt-2">
                {integration.log.map((entry, i) => (
                  <li key={i} className="text-xs text-muted">
                    <span className="font-medium">{entry.date}</span> — {entry.note}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
