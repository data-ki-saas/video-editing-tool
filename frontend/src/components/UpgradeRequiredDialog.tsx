"use client";

import Link from "next/link";
import type { FeatureLockedError } from "@/lib/api";

/**
 * Shown when a gated action 403s with a FeatureLockedError (see
 * backend/src/permissions/service.py's feature_denied_detail) -- same small
 * backdrop+card chrome as RenderComingSoonPopup.tsx, no new dependency.
 * Server-side enforcement (require_feature / the render route's
 * /api/permissions/assert call) is what actually blocks the action; this is
 * just the explanation shown after that block happens.
 */
export function UpgradeRequiredDialog({ error, onClose }: { error: FeatureLockedError; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Upgrade required"
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-lg bg-surface p-4 shadow-lg">
        <p className="text-sm font-medium text-foreground">Upgrade required</p>
        <p className="mt-1 text-sm text-muted">{error.message}</p>
        <div className="mt-3 flex gap-2">
          {error.upgradeUrl && (
            <Link
              href={error.upgradeUrl}
              className="flex-1 rounded-md bg-accent py-1.5 text-center text-sm font-medium text-accent-foreground"
            >
              See plans
            </Link>
          )}
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-md border border-border py-1.5 text-sm font-medium hover:bg-background"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
