"use client";

/**
 * Persistent top bar for every authenticated page (see
 * app/(app)/layout.tsx) -- Home on the left, then Library/Recordings/
 * Templates/Admin(admins only)/Record(project routes only)/Account/
 * Settings/Sign out on the right. Reel-specific actions (Render, Edge
 * Render) live in the video preview's own toolbar instead (see
 * CanvasPlayer.tsx) since they act on the reel being previewed, not on
 * navigation.
 */
import Link from "next/link";
import { useParams } from "next/navigation";
import { RecordIcon } from "./editor-v2/icons/PlayerIcons";
import { SignOutButton } from "@/components/SignOutButton";
import { ReelIcon } from "@/components/IconButton";
import { AccountIcon, BookmarkIcon, LibraryIcon, RecordingsIcon, SettingsIcon, ToolsIcon } from "@/components/icons/UIIcons";
import { useIsAdmin } from "@/lib/useIsAdmin";

export function GlobalTopNav() {
  const isAdmin = useIsAdmin();
  const params = useParams<{ projectId?: string }>();
  const projectId = typeof params?.projectId === "string" ? params.projectId : null;

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
        <SignOutButton />
      </div>
    </div>
  );
}
