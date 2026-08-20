"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { listProjects, type Project } from "@/lib/projects";
import { useEditorPanel } from "@/lib/editor/EditorPanelContext";

export function DashboardSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { activePanel, setActivePanel, capabilities } = useEditorPanel();

  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((err) => setProjectsError(err instanceof Error ? err.message : "Failed to load your reels"));
  }, []);

  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  const activeProjectId = pathname?.match(/^\/dashboard\/([^/]+)$/)?.[1];

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface md:flex">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-sm font-semibold">Your reels</span>
        <Link
          href="/dashboard/new"
          className="rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-foreground hover:opacity-90"
        >
          + Project
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {projectsError && <p className="px-2 py-1 text-xs text-red-600">{projectsError}</p>}
        {!projectsError && !projects && <p className="px-2 py-1 text-xs text-muted">Loading…</p>}
        {projects?.length === 0 && <p className="px-2 py-1 text-xs text-muted">No reels yet.</p>}

        <ul className="flex flex-col gap-0.5">
          {projects?.map((project) => (
            <li key={project.id}>
              <Link
                href={`/dashboard/${project.id}`}
                className={
                  "block truncate rounded-md px-2 py-1.5 text-sm " +
                  (project.id === activeProjectId
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-background")
                }
              >
                {project.name}
              </Link>
            </li>
          ))}
        </ul>

        {capabilities && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted">Actions</p>
            <ul className="flex flex-col gap-0.5">
              {capabilities.actions.map((action) => (
                <li key={action.key}>
                  <button
                    type="button"
                    onClick={() => setActivePanel(action.key)}
                    disabled={action.disabled}
                    className={
                      "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 " +
                      (activePanel === action.key
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-background")
                    }
                  >
                    <span className="truncate">{action.label}</span>
                    {action.busy && (
                      <span
                        className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
                        aria-hidden="true"
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </nav>

      <div className="flex flex-col gap-1 border-t border-border px-2 py-2 text-sm">
        <Link href="/settings" className="rounded-md px-2 py-1.5 text-muted hover:bg-background">
          Settings
        </Link>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="rounded-md px-2 py-1.5 text-left text-muted hover:bg-background disabled:opacity-50"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </aside>
  );
}
