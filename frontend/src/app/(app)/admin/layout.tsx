"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ADMIN_NAV_ITEMS = [
  { href: "/admin/roles", label: "Roles" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/integrations", label: "Integrations" },
  { href: "/admin/usage", label: "Usage" },
];

// Replaces the old /admin landing page's four action cards -- always
// visible now instead of a one-time click-through, and sticky so it stays
// in view while a long section (e.g. usage's daily cost list) scrolls past
// it inside app/(app)/layout.tsx's own scrolling <main>.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

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
                  "rounded-md px-3 py-2 text-sm font-medium " +
                  (isActive ? "bg-surface text-foreground" : "text-muted hover:bg-foreground/10")
                }
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
