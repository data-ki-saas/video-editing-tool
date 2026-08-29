"use client";

import Link from "next/link";
import { SignOutButton } from "@/components/SignOutButton";
import { AccountIcon, SettingsIcon, ToolsIcon } from "@/components/icons/UIIcons";
import { useIsAdmin } from "@/lib/useIsAdmin";

// Top bar for bare /dashboard and /dashboard/new -- a route group so it
// doesn't wrap /dashboard/[projectId], which needs every pixel of vertical
// height it can get for its 30/50/20 editor split; settings/sign-out live
// in FeedbackArea's own corner there instead (see
// components/editor-v2/FeedbackArea.tsx).
export default function DashboardChromeLayout({ children }: { children: React.ReactNode }) {
  const isAdmin = useIsAdmin();

  return (
    <>
      <div className="flex shrink-0 items-center justify-end gap-1 border-b border-border px-4 py-2">
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
        <SignOutButton />
      </div>
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </>
  );
}
