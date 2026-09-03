"use client";

/**
 * Project switcher, living inside the Action Area (left of the asset
 * gallery) rather than as a persistent full-height sidebar. Replaces that
 * role from the now-removed DashboardSidebar -- Settings lives in
 * TopMenuBar instead (top-right), not duplicated here.
 *
 * The active reel's name is inline-editable right here instead of a
 * separate page header strip (which just duplicated it) -- there's no Link
 * on that one item, since navigating to the page you're already on is a
 * no-op; every other item is a plain navigable Link.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { listProjects, deleteProject, resetProject, renameProject, type Project } from "@/lib/projects";
import { clearLastProjectId } from "@/lib/lastProject";
import { InlineEditableText } from "@/components/InlineEditableText";
import { TrashIcon, ResetIcon } from "@/components/icons/UIIcons";
import { ContextMenu, useContextMenu } from "./ContextMenu";

export function ProjectList({ activeProjectId }: { activeProjectId: string }) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { contextMenuState, openContextMenu, closeContextMenu } = useContextMenu();

  useEffect(() => {
    listProjects()
      .then(setProjects)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your reels"));
  }, []);

  async function handleDelete(project: Project) {
    if (!window.confirm(`Delete "${project.name}"? This can't be undone.`)) return;
    try {
      await deleteProject(project.id);
      setProjects((prev) => prev?.filter((p) => p.id !== project.id) ?? prev);
      // The deleted reel's own editor page is currently open under us --
      // bounce to bare /dashboard, which resumes into whichever reel is
      // next most recent (see lib/lastProject.ts). Clear the cached id
      // FIRST: it still points at this now-deleted reel, so bare /dashboard
      // would otherwise read it back and redirect straight into the dead
      // reel's URL again.
      if (project.id === activeProjectId) {
        clearLastProjectId();
        router.push("/dashboard");
      }
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete this reel");
    }
  }

  async function handleReset(project: Project) {
    if (!window.confirm(`Reset "${project.name}"? This clears every asset and edit -- the reel itself stays.`)) return;
    try {
      await resetProject(project.id);
      // If this is the reel currently open under us, ThreePaneEditor's own
      // in-memory state (assets, undo history, every open dialog) is now
      // stale -- a full reload is the simplest way to get it to re-fetch
      // and remount from scratch, the same as opening this reel fresh
      // would. A reel reset from the list while a DIFFERENT reel is open
      // needs no reload: nothing on screen refers to it.
      if (project.id === activeProjectId) window.location.reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to reset this reel");
    }
  }

  function handleRename(project: Project, name: string) {
    const previousName = project.name;
    setProjects((prev) => prev?.map((p) => (p.id === project.id ? { ...p, name } : p)) ?? prev);
    renameProject(project.id, name).catch((err) => {
      window.alert(err instanceof Error ? err.message : "Failed to rename this reel");
      setProjects((prev) => prev?.map((p) => (p.id === project.id ? { ...p, name: previousName } : p)) ?? prev);
    });
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">Reels</h2>
        <Link href="/dashboard/new" className="shrink-0 text-xs text-accent hover:underline">
          + New
        </Link>
      </div>

      <ul className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
        {error && <p className="text-xs text-red-600">{error}</p>}
        {!error && !projects && <p className="text-xs text-muted">Loading…</p>}
        {projects?.map((project) => {
          const isActive = project.id === activeProjectId;
          return (
            <li
              key={project.id}
              aria-current={isActive ? "page" : undefined}
              className={`flex items-center gap-1 rounded-md border-l-2 ${
                isActive ? "border-accent bg-accent/10" : "border-transparent"
              }`}
              onContextMenu={(e) =>
                openContextMenu(e, [
                  { label: "Reset", onSelect: () => void handleReset(project) },
                  { label: "Delete", danger: true, onSelect: () => void handleDelete(project) },
                ])
              }
            >
              <div className="min-w-0 flex-1">
                {isActive ? (
                  <InlineEditableText
                    value={project.name}
                    onCommit={(name) => handleRename(project, name)}
                    ariaLabel="Reel name"
                    className="block w-full truncate rounded-md px-2 py-1 text-sm font-medium text-accent"
                    inputClassName="block w-full truncate rounded-md border border-border px-2 py-1 text-sm font-medium text-accent outline-none"
                  />
                ) : (
                  <Link
                    href={`/dashboard/${project.id}`}
                    title={project.name}
                    className="block truncate rounded-md px-2 py-1 text-sm text-foreground hover:bg-background"
                  >
                    {project.name}
                  </Link>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleReset(project)}
                title={`Reset "${project.name}"`}
                aria-label={`Reset ${project.name}`}
                className="shrink-0 rounded-md p-1 text-muted hover:bg-background hover:text-foreground"
              >
                <ResetIcon className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(project)}
                title={`Delete "${project.name}"`}
                aria-label={`Delete ${project.name}`}
                className="shrink-0 rounded-md p-1 text-muted hover:bg-background hover:text-red-600"
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ul>

      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}
