"use client";

/**
 * Project switcher, living inside the Action Area (left of the asset
 * gallery) rather than as a persistent full-height sidebar. Replaces that
 * role from the now-removed DashboardSidebar -- "Settings" is kept here too
 * since it had no other home once the sidebar went away.
 *
 * The active reel's name is inline-editable right here instead of a
 * separate page header strip (which just duplicated it) -- there's no Link
 * on that one item, since navigating to the page you're already on is a
 * no-op; every other item is a plain navigable Link.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { listProjects, deleteProject, renameProject, type Project } from "@/lib/projects";
import { InlineEditableText } from "@/components/InlineEditableText";
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
      // next most recent (see lib/lastProject.ts).
      if (project.id === activeProjectId) router.push("/dashboard");
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Failed to delete this reel");
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
        <h2 className="text-sm font-medium text-foreground">Your reels</h2>
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
              onContextMenu={(e) =>
                openContextMenu(e, [{ label: "Delete", danger: true, onSelect: () => void handleDelete(project) }])
              }
            >
              {isActive ? (
                <InlineEditableText
                  value={project.name}
                  onCommit={(name) => handleRename(project, name)}
                  ariaLabel="Reel name"
                  className="block w-full truncate rounded-md bg-accent px-2 py-1 text-sm text-accent-foreground"
                  inputClassName="block w-full truncate rounded-md border border-accent-foreground/40 bg-accent px-2 py-1 text-sm text-accent-foreground outline-none"
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
            </li>
          );
        })}
      </ul>

      <Link href="/settings" className="shrink-0 text-xs text-muted hover:underline">
        Settings
      </Link>

      <ContextMenu state={contextMenuState} onClose={closeContextMenu} />
    </div>
  );
}
