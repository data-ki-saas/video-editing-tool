"use client";

/**
 * Persistent top bar for every authenticated page (see
 * app/(app)/layout.tsx) -- Home on the left, then Record(project routes
 * only)/Dashboard/Library/Recordings/Templates/Admin(admins only)/
 * Account/Settings/Sign out on the right. Reel-specific actions (Render,
 * Edge Render) live in the video preview's own toolbar instead (see
 * CanvasPlayer.tsx) since they act on the reel being previewed, not on
 * navigation.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { RecordIcon } from "./editor-v2/icons/PlayerIcons";
import { SignOutButton } from "@/components/SignOutButton";
import { ReelIcon } from "@/components/IconButton";
import { AccountIcon, BookmarkIcon, DashboardIcon, LibraryIcon, RecordingsIcon, SettingsIcon, ToolsIcon } from "@/components/icons/UIIcons";
import { useIsAdmin } from "@/lib/useIsAdmin";
import { getActiveImpersonation, stopImpersonation, type ActiveImpersonation } from "@/lib/impersonation";

export function GlobalTopNav() {
  const isAdmin = useIsAdmin();
  const router = useRouter();
  const params = useParams<{ projectId?: string }>();
  const projectId = typeof params?.projectId === "string" ? params.projectId : null;

  const [impersonation, setImpersonation] = useState<ActiveImpersonation | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first client-side read of localStorage, can't happen any earlier
    setImpersonation(getActiveImpersonation());
  }, []);

  async function handleStopImpersonation() {
    setStopping(true);
    try {
      await stopImpersonation();
      router.push("/admin/users");
      router.refresh();
    } finally {
      setStopping(false);
    }
  }

  return (
    <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
      <Link
        href="/"
        aria-label="Home"
        title="Home"
        className="rounded-full bg-neutral-100 p-2 text-neutral-900 hover:bg-neutral-200"
      >
        <span className="block h-5 w-5">
          <ReelIcon />
        </span>
      </Link>

      <div className="flex items-center gap-2 pr-1">
        {projectId && (
          <Link
            href={`/dashboard/${projectId}/record`}
            aria-label="Record"
            title="Record a video or take a photo"
            className="rounded-full bg-neutral-700 p-2 text-white hover:bg-neutral-600"
          >
            <RecordIcon className="h-5 w-5" />
          </Link>
        )}
        <Link
          href="/dashboard"
          aria-label="Dashboard"
          title="Dashboard"
          className="rounded-full p-2 text-muted hover:bg-foreground/10"
        >
          <DashboardIcon className="h-5 w-5" />
        </Link>
        <Link
          href="/library"
          aria-label="Library"
          title="Library"
          className="rounded-full p-2 text-muted hover:bg-foreground/10"
        >
          <LibraryIcon className="h-5 w-5" />
        </Link>
        <Link
          href="/recordings"
          aria-label="Recordings"
          title="Recordings"
          className="rounded-full p-2 text-muted hover:bg-foreground/10"
        >
          <RecordingsIcon className="h-5 w-5" />
        </Link>
        <Link
          href="/library?tab=templates"
          aria-label="Templates"
          title="Templates"
          className="rounded-full p-2 text-muted hover:bg-foreground/10"
        >
          <BookmarkIcon className="h-5 w-5" />
        </Link>
        {isAdmin && (
          <Link
            href="/admin"
            aria-label="Admin"
            title="Admin"
            className="rounded-full p-2 text-muted hover:bg-foreground/10"
          >
            <ToolsIcon className="h-5 w-5" />
          </Link>
        )}
        <Link
          href="/account/usage"
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
        {impersonation && (
          <button
            type="button"
            onClick={handleStopImpersonation}
            disabled={stopping}
            aria-label={`Impersonating ${impersonation.email ?? "a user"} -- click to stop`}
            title={`Impersonating ${impersonation.email ?? "a user"} -- click to stop`}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-yellow-400 text-yellow-950 hover:bg-yellow-300 disabled:opacity-50"
          >
            <AccountIcon className="h-4 w-4" />
          </button>
        )}
        <SignOutButton />
      </div>
    </div>
  );
}
