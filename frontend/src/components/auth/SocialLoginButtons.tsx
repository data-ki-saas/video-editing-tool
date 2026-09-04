"use client";

/**
 * "Continue with Google/Facebook" -- shared by (marketing)/login and
 * (marketing)/signup (both flows are the same call: Supabase treats a
 * first-time OAuth sign-in as an implicit sign-up, so there's no separate
 * "social sign up" button). Redirects to Google/Facebook's own consent
 * screen, which redirects back to app/auth/callback/route.ts to exchange
 * the resulting code for a session -- see that route's own comment, and
 * DEPLOY.md's "OAuth Providers" section for the Supabase-dashboard setup
 * this depends on (enabling each provider + its Client ID/Secret).
 */
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Provider = "google" | "facebook";

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className}>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.5 29.6 4.5 24 4.5 13.2 4.5 4.5 13.2 4.5 24S13.2 43.5 24 43.5 43.5 34.8 43.5 24c0-1.2-.1-2.4-.3-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.5 16 18.9 13.5 24 13.5c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.5 29.6 4.5 24 4.5c-7.7 0-14.3 4.4-17.7 10.2z" />
      <path fill="#4CAF50" d="M24 43.5c5.5 0 10.4-1.9 14.3-5.1l-6.6-5.4C29.6 34.7 26.9 36 24 36c-5.3 0-9.7-3.3-11.3-8H6v6.5C9.4 39.6 16.2 43.5 24 43.5z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.4l6.6 5.4C41.7 35.1 43.5 30 43.5 24c0-1.2-.1-2.4-.3-3.5z" />
    </svg>
  );
}

function FacebookIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <path
        fill="#1877F2"
        d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"
      />
    </svg>
  );
}

export function SocialLoginButtons() {
  const [loadingProvider, setLoadingProvider] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(provider: Provider) {
    setError(null);
    setLoadingProvider(provider);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });

    // On success the browser navigates away to the provider's consent
    // screen -- there's nothing more to do here. Only an immediate local
    // failure (misconfigured provider, network error) reaches this line.
    if (error) {
      setError(error.message);
      setLoadingProvider(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted">OR</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <button
        type="button"
        onClick={() => handleClick("google")}
        disabled={loadingProvider !== null}
        className="flex items-center justify-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-foreground hover:bg-background disabled:opacity-50"
      >
        <GoogleIcon className="h-4 w-4" />
        {loadingProvider === "google" ? "Redirecting…" : "Continue with Google"}
      </button>

      <button
        type="button"
        onClick={() => handleClick("facebook")}
        disabled={loadingProvider !== null}
        className="flex items-center justify-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-sm font-medium text-foreground hover:bg-background disabled:opacity-50"
      >
        <FacebookIcon className="h-4 w-4" />
        {loadingProvider === "facebook" ? "Redirecting…" : "Continue with Facebook"}
      </button>

      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
