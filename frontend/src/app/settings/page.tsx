"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useTheme } from "@/components/theme-provider";
import { COLOR_THEMES, THEME_MODES } from "@/lib/theme";
import { resetPermissionsCache, usePermissions } from "@/lib/usePermissions";

export default function SettingsPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const { mode, colorTheme, setMode, setColorTheme } = useTheme();
  const { loading: isLoadingRole, roleLabel, badgeColor } = usePermissions();

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createClient();
    await supabase.auth.signOut();
    resetPermissionsCache(); // a different user signing in in this tab shouldn't see this session's cached role/features
    router.push("/");
    router.refresh();
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-12">
      <div>
        <Link href="/dashboard" className="text-sm text-muted hover:underline">
          ← Reels
        </Link>
        <h1 className="text-2xl font-semibold">Settings</h1>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Account</h2>
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted">{email ?? "Loading…"}</p>
          {!isLoadingRole && roleLabel && (
            <span
              className="rounded-full px-2 py-0.5 text-xs font-medium text-white"
              style={{ backgroundColor: badgeColor ?? "#64748b" }}
            >
              {roleLabel}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          disabled={signingOut}
          className="self-start rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface disabled:opacity-50"
        >
          {signingOut ? "Signing out…" : "Sign out"}
        </button>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Appearance</h2>
        <div className="flex gap-2">
          {THEME_MODES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMode(option)}
              className={
                "rounded-md border px-4 py-2 text-sm capitalize transition-colors " +
                (mode === option
                  ? "border-accent bg-accent text-accent-foreground"
                  : "border-border text-foreground hover:bg-surface")
              }
            >
              {option}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Colour theme</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {COLOR_THEMES.map((theme) => (
            <button
              key={theme.value}
              type="button"
              onClick={() => setColorTheme(theme.value)}
              className={
                "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors " +
                (colorTheme === theme.value
                  ? "border-accent ring-1 ring-accent"
                  : "border-border text-foreground hover:bg-surface")
              }
            >
              <span
                className="h-4 w-4 shrink-0 rounded-full border border-border"
                style={{ backgroundColor: theme.swatch }}
              />
              {theme.label}
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-md border border-dashed border-border p-4">
        <h2 className="text-lg font-medium text-muted">Branding</h2>
        <p className="text-sm text-muted">
          {/* Placeholder -- ties to the deferred white-label/agency-tier idea.
              Not built yet; kept on the backlog until core usability is established. */}
          Coming soon: add your logo and brand colors to apply consistently across every
          reel you create.
        </p>
      </section>
    </main>
  );
}
