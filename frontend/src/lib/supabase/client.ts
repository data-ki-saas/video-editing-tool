import { createBrowserClient } from "@supabase/ssr";

// A stalled (not outright failed) response from Auth left login/signup stuck
// on "Please wait..." forever, since supabase-js has no built-in request
// timeout. This caps every request this client makes so a stalled call fails
// fast with a visible error instead of hanging.
//
// Deliberately NOT the same value as middleware.ts's timeout: that one guards
// a per-navigation session check that can safely fail open (page loads
// through unauthenticated) and so wants to fail fast. This client also
// carries the actual login/signup credential POST, which has no "fail open"
// option and legitimately needs more headroom than a session lookup (a cold
// preflight/connection setup can itself eat several seconds before the real
// request even starts) -- an 8s budget for the whole thing was aborting the
// login POST mid-flight rather than letting it complete.
const BROWSER_AUTH_TIMEOUT_MS = 20000;

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(BROWSER_AUTH_TIMEOUT_MS) });
}

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { fetch: fetchWithTimeout } }
  );
}
