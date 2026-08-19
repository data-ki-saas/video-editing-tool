import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/** Service-role client -- bypasses RLS entirely. ONLY for routes that have no
 * Supabase user session to work with (e.g. a third-party webhook callback),
 * where there's no `auth.uid()` for a policy to check against in the first
 * place. Every caller must filter by an unguessable identifier it already
 * verified belongs to the right row (e.g. a stored render_id) -- this client
 * enforces nothing on its own.
 *
 * This duplicates the same secret backend/src/core/supabase_client.py holds
 * for the FastAPI backend -- an accepted tradeoff for keeping the webhook
 * receiver in this Next.js app rather than splitting it across two services.
 * Keep SUPABASE_SERVICE_ROLE_KEY out of NEXT_PUBLIC_ env vars; it must never
 * reach the browser bundle. */
export function createServiceRoleClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
