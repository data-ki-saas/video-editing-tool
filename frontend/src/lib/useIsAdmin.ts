"use client";

import { usePermissions } from "@/lib/usePermissions";

/** Backs the header's admin-only Tools icon and /admin's own page guard.
 * Delegates to usePermissions()'s "admin_manage_roles" feature (see
 * backend/src/permissions/features.py) rather than checking profiles.role
 * directly -- role is no longer synonymous with "admin" now that roles are
 * admin-creatable (see supabase/migrations/0015). Returns null while
 * loading; a failed/unresolved permissions fetch resolves to false (fail
 * closed -- see usePermissions' own comment). This client-side check is a
 * UI convenience only, not a security boundary -- any real admin endpoint
 * must gate on the backend's require_feature("admin_manage_roles") instead. */
export function useIsAdmin(): boolean | null {
  const { loading, has } = usePermissions();
  if (loading) return null;
  return has("admin_manage_roles");
}
