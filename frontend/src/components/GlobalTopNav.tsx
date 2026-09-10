"use client";

/**
 * Persistent top bar for every authenticated page (see
 * app/(app)/layout.tsx) -- Home on the left, then Record(project routes
 * only)/Dashboard/Library/Recordings/Templates/Admin(admins only)/Support/
 * Account/Settings/Sign out on the right. Reel-specific actions (Render,
 * Edge Render) live in the video preview's own toolbar instead (see
 * CanvasPlayer.tsx) since they act on the reel being previewed, not on
 * navigation.
 *
 * Below the `sm` breakpoint that right-hand icon row is wider than a phone
 * screen, so it collapses into a single hamburger button opening a
 * full-screen menu -- same overlay shape as the mobile editor's own
 * MobileReelMenu.tsx (fixed inset-0, header+close, scrollable list) rather
 * than a dropdown, since there's no room for a persistent panel at
 * phone width either.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import type { SVGProps } from "react";
import { useParams, useRouter } from "next/navigation";
import { RecordIcon } from "./editor-v2/icons/PlayerIcons";
import { SignOutButton } from "@/components/SignOutButton";
import { ReelIcon } from "@/components/IconButton";
import {
  AccountIcon,
  BookmarkIcon,
  DashboardIcon,
  LibraryIcon,
  MenuIcon,
  RecordingsIcon,
  SettingsIcon,
  SupportIcon,
  ToolsIcon,
} from "@/components/icons/UIIcons";
import { useIsAdmin } from "@/lib/useIsAdmin";
import { getActiveImpersonation, stopImpersonation, type ActiveImpersonation } from "@/lib/impersonation";
import { getTicketUnreadCount } from "@/lib/api";

type NavLink = {
  key: string;
  href: string;
  label: string;
  icon: (props: SVGProps<SVGSVGElement>) => React.ReactElement;
  badge?: boolean;
};

export function GlobalTopNav() {
  const isAdmin = useIsAdmin();
  const router = useRouter();
  const params = useParams<{ projectId?: string }>();
  const projectId = typeof params?.projectId === "string" ? params.projectId : null;

  const [impersonation, setImpersonation] = useState<ActiveImpersonation | null>(null);
  const [stopping, setStopping] = useState(false);
  const [hasUnreadTickets, setHasUnreadTickets] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- first client-side read of localStorage, can't happen any earlier
    setImpersonation(getActiveImpersonation());
  }, []);

  useEffect(() => {
    // One-shot on mount, not a live poll -- refreshes again on the next full
    // navigation into a page that remounts this bar. Errors are swallowed
    // (e.g. signed-out on a marketing page) since a missing dot is harmless.
    getTicketUnreadCount()
      .then((count) => setHasUnreadTickets(count > 0))
      .catch(() => undefined);
  }, []);

  async function handleStopImpersonation() {
    setStopping(true);
    try {
      await stopImpersonation();
      router.push("/admin/users");
      router.refresh();
      setIsMenuOpen(false);
    } finally {
      setStopping(false);
    }
  }

  const navLinks: NavLink[] = [
    { key: "dashboard", href: "/dashboard", label: "Dashboard", icon: DashboardIcon },
    { key: "library", href: "/library", label: "Library", icon: LibraryIcon },
    { key: "recordings", href: "/recordings", label: "Recordings", icon: RecordingsIcon },
    { key: "templates", href: "/library?tab=templates", label: "Templates", icon: BookmarkIcon },
    ...(isAdmin ? [{ key: "admin", href: "/admin", label: "Admin", icon: ToolsIcon }] : []),
    { key: "support", href: "/support", label: "Support", icon: SupportIcon, badge: hasUnreadTickets },
    { key: "account", href: "/account/usage", label: "Account", icon: AccountIcon },
    { key: "settings", href: "/settings", label: "Settings", icon: SettingsIcon },
  ];

  return (
    <div className="relative flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
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

      <div className="hidden items-center gap-2 pr-1 sm:flex">
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
        {navLinks.map((link) => (
          <Link
            key={link.key}
            href={link.href}
            aria-label={link.label}
            title={link.label}
            className="relative rounded-full p-2 text-muted hover:bg-foreground/10"
          >
            <link.icon className="h-5 w-5" />
            {link.badge && (
              <span className="absolute right-1.5 top-1.5 block h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
            )}
          </Link>
        ))}
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

      <button
        type="button"
        onClick={() => setIsMenuOpen(true)}
        aria-label="Menu"
        title="Menu"
        className="relative rounded-full p-2 text-muted hover:bg-foreground/10 sm:hidden"
      >
        <MenuIcon className="h-5 w-5" />
        {hasUnreadTickets && (
          <span className="absolute right-1.5 top-1.5 block h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
        )}
      </button>

      {isMenuOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background sm:hidden">
          <div className="flex items-center justify-between border-b border-border p-3">
            <h2 className="text-sm font-semibold text-foreground">Menu</h2>
            <button
              type="button"
              onClick={() => setIsMenuOpen(false)}
              aria-label="Close"
              className="rounded-full p-2 text-muted hover:bg-foreground/10"
            >
              ✕
            </button>
          </div>

          <nav className="flex-1 overflow-y-auto p-2">
            {projectId && (
              <Link
                href={`/dashboard/${projectId}/record`}
                onClick={() => setIsMenuOpen(false)}
                className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm text-foreground hover:bg-foreground/5"
              >
                <RecordIcon className="h-5 w-5 shrink-0 text-muted" />
                Record
              </Link>
            )}
            {navLinks.map((link) => (
              <Link
                key={link.key}
                href={link.href}
                onClick={() => setIsMenuOpen(false)}
                className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm text-foreground hover:bg-foreground/5"
              >
                <span className="relative h-5 w-5 shrink-0 text-muted">
                  <link.icon className="h-5 w-5" />
                  {link.badge && (
                    <span className="absolute -right-0.5 -top-0.5 block h-2 w-2 rounded-full bg-red-500" aria-hidden="true" />
                  )}
                </span>
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center justify-between border-t border-border p-3">
            {impersonation ? (
              <button
                type="button"
                onClick={handleStopImpersonation}
                disabled={stopping}
                className="rounded-md bg-yellow-400 px-3 py-2 text-xs font-medium text-yellow-950 hover:bg-yellow-300 disabled:opacity-50"
              >
                Stop impersonating {impersonation.email ?? "user"}
              </button>
            ) : (
              <span />
            )}
            <SignOutButton />
          </div>
        </div>
      )}
    </div>
  );
}
