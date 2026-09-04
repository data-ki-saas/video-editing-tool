import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Where Google/Facebook redirect back to after their own consent screen
// (see SocialLoginButtons.tsx's signInWithOAuth `redirectTo`) -- Supabase's
// PKCE flow hands this route a one-time `code` in the query string, which
// this exchanges for a real session (cookies set via createClient's
// `setAll`). Must be exempted from the auth wall in
// lib/supabase/middleware.ts (OAUTH_CALLBACK_PATH) -- this request arrives
// with no session cookie yet (that's exactly what it's about to create),
// so the normal "no user -> redirect to /login" rule would otherwise fire
// before the exchange below ever runs.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    console.error("[auth/callback] exchangeCodeForSession failed", error);
  }

  return NextResponse.redirect(`${origin}/login?error=oauth`);
}
