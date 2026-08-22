/**
 * Remembers which project the user was last working on, so opening the
 * dashboard resumes there instead of showing an empty picker (see
 * app/dashboard/page.tsx). Plain localStorage rather than a DB column --
 * this is a client-side "where was I" convenience, scoped per browser, not
 * something that needs to sync across devices.
 */
const STORAGE_KEY = "reel-creator:last-project-id";

export function getLastProjectId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(STORAGE_KEY);
}

export function setLastProjectId(projectId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, projectId);
}
