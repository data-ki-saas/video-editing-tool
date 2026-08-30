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

type Integration = {
  name: string;
  purpose: string;
  pricingNote: string;
  docsUrl?: string;
  log: LogEntry[];
};

const INTEGRATIONS: Integration[] = [
  {
    name: "Creatomate",
    purpose: "Server-side video rendering (final reel export) and the browser Preview SDK used by the editor.",
    pricingNote: "Paid SaaS, credit/render-minute based. No self-hosted fallback -- see DEPLOY.md step 3.",
    docsUrl: "https://creatomate.com/pricing",
    log: [
      { date: "2026-08-24", note: "Chosen over self-hosted ffmpeg rendering -- see project memory \"Render backend decision\"." },
    ],
  },
  {
    name: "DeepSeek",
    purpose: "Default LLM provider -- powers niche-config generation (New Reel form fields + voiceover script template).",
    pricingNote: "Pay-per-token API. Swappable for Anthropic via LLM_PROVIDER=anthropic (see backend/src/llm/).",
    docsUrl: "https://platform.deepseek.com",
    log: [],
  },
  {
    name: "HeyGen",
    purpose: "Talking-avatar video generation for the voiceover step's optional \"Deliver as a talking avatar video\" feature.",
    pricingNote: "Pay-as-you-go, no free tier as of writing. Roughly $0.02-0.07/sec of avatar video -- keep AVATAR_DAILY_CAP small.",
    docsUrl: "https://app.heygen.com",
    log: [],
  },
  {
    name: "Cloudflare R2",
    purpose: "Object storage -- private uploads bucket + public CDN-fronted finished-renders bucket.",
    pricingNote: "Usage-based storage, zero egress fees (the reason it was picked over S3 for the public renders bucket).",
    docsUrl: "https://developers.cloudflare.com/r2/pricing/",
    log: [],
  },
  {
    name: "Supabase",
    purpose: "Postgres database + Auth.",
    pricingNote: "Free tier in POC phase; check project usage before scaling.",
    docsUrl: "https://supabase.com/pricing",
    log: [],
  },
  {
    name: "Render",
    purpose: "Hosts the FastAPI backend and the render-transfer worker.",
    pricingNote: "Free tier spins down when idle (cold starts up to 30-60s) -- see DEPLOY.md pitfall #9.",
    docsUrl: "https://render.com/pricing",
    log: [],
  },
  {
    name: "Vercel",
    purpose: "Hosts the Next.js frontend, including the render-trigger and Creatomate-webhook API routes.",
    pricingNote: "Free tier in POC phase.",
    docsUrl: "https://vercel.com/pricing",
    log: [],
  },
  {
    name: "Pexels",
    purpose: "Stock photo/video search in the editor. Optional -- disabled without PEXELS_API_KEY.",
    pricingNote: "Free API.",
    docsUrl: "https://www.pexels.com/api/",
    log: [],
  },
  {
    name: "Freesound",
    purpose: "Stock music search in the editor. Optional -- disabled without FREESOUND_API_KEY.",
    pricingNote: "Free API (basic token auth).",
    docsUrl: "https://freesound.org/apiv2/apply/",
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
          Reference info only -- pricing and plan notes, plus a dated log per
          integration. Update this file directly when something changes.
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
