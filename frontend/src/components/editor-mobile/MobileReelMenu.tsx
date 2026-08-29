"use client";

/**
 * The mobile editor's only entry point to switching reels, Settings, or
 * signing out -- MobileEditor has no persistent sidebar (unlike
 * ThreePaneEditor's ProjectList) and isn't wrapped by the (chrome) layout
 * bare /dashboard uses (unlike /dashboard/new), so without this there was
 * genuinely no way on a phone to reach a reel other than whichever one
 * bare /dashboard's cached "last project" happened to resume into, and no
 * way to sign out at all. A full-screen overlay rather than a slide-over
 * sidebar -- there's no room to keep a persistent panel on a phone-width
 * screen the way ThreePaneEditor does on desktop.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { listProjects, type Project } from "@/lib/projects";
import { SignOutButton } from "@/components/SignOutButton";
import { AccountIcon, SettingsIcon, ToolsIcon } from "@/components/icons/UIIcons";
import { useIsAdmin } from "@/lib/useIsAdmin";

export function MobileReelMenu({ currentProjectId, onClose }: { currentProjectId: string; onClose: () => void }) {
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your reels"));
  }, []);

  function handleSelect(projectId: string) {
    onClose();
    if (projectId !== currentProjectId) router.push(`/dashboard/${projectId}`);
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border p-3">
        <h2 className="text-sm font-semibold text-foreground">Your Reels</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-full p-2 text-muted hover:bg-foreground/10"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {error && <p className="text-sm text-red-600">{error}</p>}
        {!error && !projects && <p className="text-sm text-muted">Loading…</p>}
        {projects && (
          <ul className="flex flex-col gap-1">
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => handleSelect(project.id)}
                  className={`w-full truncate rounded-md px-3 py-2.5 text-left text-sm ${
                    project.id === currentProjectId
                      ? "bg-accent/10 font-medium text-accent"
                      : "text-foreground hover:bg-foreground/5"
                  }`}
                >
                  {project.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border p-3">
        <Link
          href="/dashboard/new"
          onClick={onClose}
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground"
        >
          + New Reel
        </Link>
        <div className="flex items-center gap-1">
          {isAdmin && (
            <Link
              href="/admin"
              onClick={onClose}
              aria-label="Admin"
              title="Admin"
              className="rounded-full p-2 text-muted hover:bg-foreground/10"
            >
              <ToolsIcon className="h-5 w-5" />
            </Link>
          )}
          <Link
            href="/account/usage"
            onClick={onClose}
            aria-label="Account"
            title="Account"
            className="rounded-full p-2 text-muted hover:bg-foreground/10"
          >
            <AccountIcon className="h-5 w-5" />
          </Link>
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className="rounded-full p-2 text-muted hover:bg-foreground/10"
          >
            <SettingsIcon className="h-5 w-5" />
          </Link>
          <SignOutButton />
        </div>
      </div>
    </div>
  );
}
