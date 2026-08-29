"use client";

import { useEffect, useState } from "react";
import { getMyPermissions, type MyPermissions } from "@/lib/api";

// Module-level cache: every usePermissions() call in the same tab shares one
// GET /api/permissions/me round-trip rather than each mounting component
// re-fetching it. Reset on sign-out (see settings/page.tsx's handleSignOut)
// so a different user signing in in the same tab doesn't see the previous
// user's cached permissions.
let cachedPromise: Promise<MyPermissions> | null = null;

function fetchPermissions(): Promise<MyPermissions> {
  if (!cachedPromise) {
    cachedPromise = getMyPermissions().catch((err) => {
      cachedPromise = null; // let the next mount retry instead of caching a failure forever
      throw err;
    });
  }
  return cachedPromise;
}

export function resetPermissionsCache() {
  cachedPromise = null;
}

export interface UsePermissionsResult {
  loading: boolean;
  role: string | null;
  roleLabel: string | null;
  badgeColor: string | null;
  features: string[];
  /** Fails CLOSED while loading or on error -- an unresolved/failed
   * permissions fetch must never read as "allowed". Client-side gating is a
   * UX nicety only; the real enforcement is always server-side
   * (require_feature / the render route's /api/permissions/assert call). */
  has: (featureKey: string) => boolean;
}

export function usePermissions(): UsePermissionsResult {
  const [permissions, setPermissions] = useState<MyPermissions | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchPermissions()
      .then((result) => {
        if (!cancelled) setPermissions(result);
      })
      .catch((err) => {
        console.error("[usePermissions] failed to load permissions", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    loading,
    role: permissions?.role ?? null,
    roleLabel: permissions?.roleLabel ?? null,
    badgeColor: permissions?.badgeColor ?? null,
    features: permissions?.features ?? [],
    has: (featureKey: string) => permissions?.features.includes(featureKey) ?? false,
  };
}
