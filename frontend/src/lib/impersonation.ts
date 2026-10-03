"use client";

/** Admin "impersonate user" support -- see admin/users/page.tsx (starts it)
 * and GlobalTopNav.tsx (shows the yellow indicator + stops it).
 *
 * This swaps the browser's actual Supabase session, not just a UI label:
 * setSession() is mirrored into cookies by @supabase/ssr's browser client,
 * so the backend and middleware see the target user on every request that
 * follows too. localStorage (not sessionStorage) on purpose -- the swapped
 * session is a browser-wide cookie change, so every tab should agree on
 * whether it's currently impersonating.
 */
import { createClient } from "@/lib/supabase/client";
import { impersonateUser } from "@/lib/api";
import { resetPermissionsCache } from "@/lib/usePermissions";

const STORAGE_KEY = "impersonation";

interface StoredImpersonation {
  adminAccessToken: string;
  adminRefreshToken: string;
  targetEmail: string | null;
  targetDisplayName: string | null;
}

export interface ActiveImpersonation {
  email: string | null;
  displayName: string | null;
}

export function getActiveImpersonation(): ActiveImpersonation | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredImpersonation;
    return { email: parsed.targetEmail, displayName: parsed.targetDisplayName };
  } catch {
    return null;
  }
}

/** Stashes the admin's own tokens, then swaps the browser session to the
 * target user's. Caller is responsible for navigating afterward (mirrors
 * SignOutButton.tsx's own router.push + router.refresh pattern). */
export async function startImpersonation(userId: string): Promise<void> {
  const supabase = createClient();
  const { data: current } = await supabase.auth.getSession();
  if (!current.session) throw new Error("Not signed in");

  const target = await impersonateUser(userId);

  const stored: StoredImpersonation = {
    adminAccessToken: current.session.access_token,
    adminRefreshToken: current.session.refresh_token,
    targetEmail: target.email,
    targetDisplayName: target.displayName,
  };

  const { error } = await supabase.auth.setSession({
    access_token: target.accessToken,
    refresh_token: target.refreshToken,
  });
  if (error) throw error;

  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  resetPermissionsCache();
}

/** Restores the admin's own session stashed by startImpersonation() above.
 * Returns "restored" when back as admin, or "signed-out" when the stashed
 * admin tokens could no longer be used (expired/revoked) -- in that case the
 * impersonated session is dropped so the user is never left stuck as the
 * target and has to sign back in. */
export async function stopImpersonation(): Promise<"restored" | "signed-out"> {
  const raw = localStorage.getItem(STORAGE_KEY);
  const supabase = createClient();

  let restored = false;
  try {
    if (raw) {
      const stored = JSON.parse(raw) as StoredImpersonation;
      const { error } = await supabase.auth.setSession({
        access_token: stored.adminAccessToken,
        refresh_token: stored.adminRefreshToken,
      });
      restored = !error;
    }
  } catch {
    restored = false;
  }

  if (!restored) await supabase.auth.signOut();

  localStorage.removeItem(STORAGE_KEY);
  resetPermissionsCache();
  return restored ? "restored" : "signed-out";
}
