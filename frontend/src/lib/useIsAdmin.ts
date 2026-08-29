"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/** Backs the header's admin-only Tools icon and /admin's own page guard.
 * Reads profiles.role directly via Supabase (RLS select-own, see
 * supabase/migrations/0014_create_profiles.sql) rather than a backend
 * round-trip -- same shape as settings/page.tsx's own supabase.auth.getUser()
 * call. Returns null while loading; a missing profiles row or any error
 * resolves to false (fail closed -- see auth.py's _lookup_role for the
 * server-side equivalent). This client-side check is a UI convenience only,
 * not a security boundary -- any real admin endpoint must gate on the
 * backend's require_admin instead. */
export function useIsAdmin(): boolean | null {
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) {
        if (!cancelled) setIsAdmin(false);
        return;
      }
      const { data: profile, error } = await supabase
        .from("profiles")
        .select("role")
        .eq("user_id", data.user.id)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        console.error("[useIsAdmin] failed to look up role", error);
        setIsAdmin(false);
        return;
      }
      setIsAdmin(profile?.role === "admin");
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return isAdmin;
}
