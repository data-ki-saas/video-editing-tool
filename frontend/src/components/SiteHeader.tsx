"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { ReelIcon } from "@/components/IconButton";

const NAV_LINKS = [
  { href: "/about", label: "About Us" },
  { href: "/contact", label: "Contact Us" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Documentation" },
];

// Same session-detection pattern as the sibling ../data project's
// SiteHeader -- renders on every marketing page, including ones a
// signed-in visitor can reach, so it needs to know live whether to offer
// "Dashboard" or "Sign in / Sign up".
export function SiteHeader() {
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => setHasSession(!!data.session));
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setHasSession(!!session);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  return (
    <header className="border-b border-border">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-2 px-4 py-4 sm:gap-4">
        <Link href="/" className="flex min-w-0 items-center gap-2 text-base font-semibold sm:text-lg">
          <span className="h-6 w-6 shrink-0">
            <ReelIcon />
          </span>
          <span className="truncate">Reel Creator</span>
        </Link>

        <nav className="flex shrink-0 items-center gap-2 text-sm sm:gap-4">
          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="hidden underline sm:inline">
              {link.label}
            </Link>
          ))}

          {hasSession ? (
            <Link
              href="/dashboard"
              className="rounded-md bg-accent px-3 py-1.5 text-accent-foreground hover:opacity-90"
            >
              Dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="underline">
                Sign in
              </Link>
              <Link
                href="/signup"
                className="rounded-md bg-accent px-3 py-1.5 text-accent-foreground hover:opacity-90"
              >
                <span className="sm:hidden">Sign up</span>
                <span className="hidden sm:inline">Sign up free</span>
              </Link>
            </>
          )}
        </nav>
      </div>

      <nav className="flex items-center gap-4 border-t border-border px-4 py-2 text-sm sm:hidden">
        {NAV_LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="underline">
            {link.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
