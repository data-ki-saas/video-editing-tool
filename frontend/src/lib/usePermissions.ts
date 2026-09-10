"use client";

import { useEffect, useState } from "react";
import { getMyPermissions, type MyPermissions } from "@/lib/api";

// Module-level cache: every usePermissions() call in the same tab shares one
// GET /api/permissions/me round-trip rather than each mounting component
// re-fetching it. Reset on sign-out (see settings/page.tsx's handleSignOut)
// so a different user signing in in the same tab doesn't see the previous
// user's cached permissions.
let cachedPromise: Promise<MyPermissions> | null = null;

// Survives across full page loads / new tabs, unlike cachedPromise above --
// covers the common case where a user already has a valid session (page
// refresh, reopening a tab, landing back on /dashboard after an OAuth
// redirect) so there's no fresh "login" moment to hang prefetchPermissions()
// off of. usePermissions() reads this at the top of its mount effect so
// admin-gated UI (GlobalTopNav's Tools icon, useIsAdmin()) paints correctly
// on the very next tick instead of showing disabled/hidden until the network
// round trip resolves. A background fetch always still runs to catch role
// changes -- this is a stale-while-revalidate cache, not a substitute for
// it. Safe to read a few minutes stale: this hook's `has()` is a UX
// convenience only, never the real enforcement (see its own doc below).
const STORAGE_KEY = "ffmpeg:permissions:v1";
const STORAGE_MAX_AGE_MS = 10 * 60 * 1000;

function readStoredPermissions(): MyPermissions | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { permissions: MyPermissions; cachedAt: number };
    if (Date.now() - parsed.cachedAt > STORAGE_MAX_AGE_MS) return null;
    return parsed.permissions;
  } catch {
    return null;
  }
}

function writeStoredPermissions(permissions: MyPermissions) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ permissions, cachedAt: Date.now() }));
  } catch {
    // storage full/disabled -- next load just falls back to a cold fetch
  }
}

function clearStoredPermissions() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function fetchPermissions(): Promise<MyPermissions> {
  if (!cachedPromise) {
    cachedPromise = getMyPermissions()
      .then((result) => {
        writeStoredPermissions(result);
        return result;
      })
      .catch((err) => {
        cachedPromise = null; // let the next mount retry instead of caching a failure forever
        throw err;
      });
  }
  return cachedPromise;
}

/** Also clears the persisted cache above -- both sign-out (settings/page.tsx)
 * and impersonation start/stop (lib/impersonation.ts) call this, and both
 * need the *next* read to be a real fetch for the new identity rather than
 * the previous one's stored role/features. */
export function resetPermissionsCache() {
  cachedPromise = null;
  clearStoredPermissions();
}

/** Kicks off the permissions fetch immediately (e.g. right after login,
 * before the first protected page even mounts) so usePermissions() finds a
 * warm/in-flight cache instead of starting cold. Fire-and-forget -- callers
 * don't need the result, just the earlier start. */
export function prefetchPermissions() {
  fetchPermissions().catch(() => undefined);
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

    // Paint the last-known role/features immediately (not just null/loading)
    // while the background fetch below revalidates -- this can't move into
    // useState's own initializer since these pages are server-rendered per
    // request (see src/lib/supabase/middleware.ts) and localStorage isn't
    // available there; reading it here instead avoids a hydration mismatch.
    const stored = readStoredPermissions();
    if (stored) {
      setPermissions(stored);
      setLoading(false);
    }

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
