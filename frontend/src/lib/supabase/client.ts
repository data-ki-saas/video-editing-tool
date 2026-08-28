import { createBrowserClient } from "@supabase/ssr";

// Mirrors src/lib/supabase/middleware.ts's fetchWithTimeout -- a stalled (not
// outright failed) response from Auth left login/signup stuck on "Please
// wait..." forever, since supabase-js has no built-in request timeout. This
// caps every request this client makes so a stalled call fails fast with a
// visible error instead of hanging.
const AUTH_CHECK_TIMEOUT_MS = 8000;

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS) });
}

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { fetch: fetchWithTimeout } }
  );
}
