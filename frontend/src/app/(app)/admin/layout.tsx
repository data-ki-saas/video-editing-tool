"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getAdminNewTicketCount } from "@/lib/api";

const ADMIN_NAV_ITEMS = [
  { href: "/admin/roles", label: "Roles" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/tickets", label: "Tickets" },
  { href: "/admin/integrations", label: "Integrations" },
  { href: "/admin/usage", label: "Usage" },
];

// Replaces the old /admin landing page's four action cards -- always
// visible now instead of a one-time click-through, and sticky so it stays
// in view while a long section (e.g. usage's daily cost list) scrolls past
// it inside app/(app)/layout.tsx's own scrolling <main>.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [newTicketCount, setNewTicketCount] = useState(0);

  useEffect(() => {
    // One-shot on mount, same lightweight-badge precedent as
    // GlobalTopNav.tsx's own unread-tickets dot.
    getAdminNewTicketCount()
      .then(setNewTicketCount)
      .catch(() => undefined);
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-5xl gap-8 px-4 py-12">
      <aside className="sticky top-0 h-fit w-40 shrink-0">
        <nav className="flex flex-col gap-1">
          {ADMIN_NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={
                  "flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium " +
                  (isActive ? "bg-surface text-foreground" : "text-muted hover:bg-foreground/10")
                }
              >
                {item.label}
                {item.href === "/admin/tickets" && newTicketCount > 0 && (
                  <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    {newTicketCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
