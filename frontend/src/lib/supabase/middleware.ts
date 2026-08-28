import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// A signed-in user hitting one of these gets bounced to /dashboard instead.
const GUEST_ONLY_PATHS = ["/login", "/signup"];
// Public for everyone, including a signed-in visitor -- unlike
// GUEST_ONLY_PATHS, a logged-in user must still be able to read these (e.g.
// from the footer), not get redirected away from them.
const MARKETING_STATIC_PATHS = ["/about", "/contact", "/pricing", "/docs", "/privacy", "/terms"];

// The Supabase client has no built-in request timeout -- a STALLED (not
// outright failed) response from Auth left this middleware hanging until
// Vercel's own hard function-timeout killed it (observed in production: a
// full 5-minute MIDDLEWARE_INVOCATION_TIMEOUT / 504 on every navigation
// while it lasted, since every request runs through this same auth check).
// This caps every request this client makes so a stalled auth check fails
// fast instead of blocking the whole page load. Deliberately shorter than
// the browser client's timeout (src/lib/supabase/client.ts) -- this one only
// guards a redirect decision that fails open, not a credential POST.
const AUTH_CHECK_TIMEOUT_MS = 8000;

function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(AUTH_CHECK_TIMEOUT_MS) });
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: fetchWithTimeout },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  let user = null;
  try {
    const result = await supabase.auth.getUser();
    user = result.data.user;
  } catch (err) {
    // Fails OPEN on the redirect decision only -- lets the request through
    // as-is rather than hanging this navigation for up to Vercel's own
    // function-timeout. Actual data access stays protected by Supabase RLS
    // and each page's own client-side auth calls (e.g.
    // dashboard/[projectId]/page.tsx's getProject().catch) regardless of
    // what this middleware decided.
    console.error("[middleware] supabase.auth.getUser() failed or timed out -- passing the request through unchecked", err);
    return response;
  }

  const { pathname } = request.nextUrl;
  const isGuestOnlyPath = GUEST_ONLY_PATHS.some((path) => pathname.startsWith(path));
  const isMarketingStaticPath = MARKETING_STATIC_PATHS.some((path) => pathname.startsWith(path));
  const isPublicPath = pathname === "/" || isGuestOnlyPath || isMarketingStaticPath;

  if (!user && !isPublicPath) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Signed-in users don't need the marketing home page or the sign-in/sign-up forms.
  if (user && (pathname === "/" || isGuestOnlyPath)) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return response;
}
