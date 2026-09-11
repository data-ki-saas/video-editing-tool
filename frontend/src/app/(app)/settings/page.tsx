"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useTheme } from "@/components/theme-provider";
import { COLOR_THEMES, THEME_MODES } from "@/lib/theme";
import { resetPermissionsCache, usePermissions } from "@/lib/usePermissions";
import { disconnectSocialAccount, getSocialAccounts, getSocialConnectUrl, type SocialAccount } from "@/lib/api";

type SocialProviderKey = "youtube" | "meta" | "instagram";

const PLATFORM_NAME: Record<SocialProviderKey, string> = {
  youtube: "YouTube",
  meta: "Facebook",
  instagram: "Instagram",
};

// `instagram` never appears here -- it's never the platform a connect
// attempt is made against (see PROVIDERS below), only ever created as a
// side effect of connecting `meta`.
const CONNECTABLE_PROVIDERS: { key: "youtube" | "meta"; label: string }[] = [
  { key: "youtube", label: "YouTube" },
  { key: "meta", label: "Facebook" },
];

function socialErrorMessage(code: string, providerKey: string | null): string {
  const platform = (providerKey && PLATFORM_NAME[providerKey as SocialProviderKey]) || "that account";
  if (code === "access_denied") return `${platform} connection was cancelled.`;
  if (code === "missing_code") return `${platform} didn't return the expected response -- try again.`;
  if (code === "connect_failed") return `Couldn't connect your ${platform} account -- try again.`;
  return "Couldn't connect that account -- try again.";
}

function SettingsPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const { mode, colorTheme, setMode, setColorTheme } = useTheme();
  const { loading: isLoadingRole, roleLabel, badgeColor, has: hasFeature } = usePermissions();
  const [socialAccounts, setSocialAccounts] = useState<SocialAccount[] | null>(null);
  const [connectingProvider, setConnectingProvider] = useState<SocialProviderKey | null>(null);
  const [disconnectingProvider, setDisconnectingProvider] = useState<SocialProviderKey | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  // Read once, lazily, off the URL this page was loaded with (right after
  // the OAuth callback's redirect back here -- see
  // backend/src/social/service.py's handle_callback) -- a lazy initializer
  // rather than an effect that calls setState, so the banner doesn't
  // immediately vanish once the query-param cleanup effect below fires.
  const [socialError] = useState<string | null>(() => {
    const code = searchParams.get("social_error");
    return code ? socialErrorMessage(code, searchParams.get("provider")) : null;
  });
  const [socialNotice] = useState<string | null>(() => {
    const provider = searchParams.get("provider") as SocialProviderKey | null;
    if (searchParams.get("social") !== "connected") return null;
    return `${(provider && PLATFORM_NAME[provider]) || "Account"} connected.`;
  });

  useEffect(() => {
    if (searchParams.get("social_error") || searchParams.get("social")) {
      router.replace("/settings");
    }
  }, [searchParams, router]);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  useEffect(() => {
    getSocialAccounts()
      .then(setSocialAccounts)
      .catch(() => setSocialAccounts([]));
  }, []);

  async function handleConnect(provider: "youtube" | "meta") {
    setConnectingProvider(provider);
    try {
      window.location.href = await getSocialConnectUrl(provider);
    } catch (err) {
      setDisconnectError(err instanceof Error ? err.message : `Couldn't start connecting ${PLATFORM_NAME[provider]}`);
      setConnectingProvider(null);
    }
  }

  async function handleDisconnect(provider: SocialProviderKey) {
    setDisconnectingProvider(provider);
    try {
      await disconnectSocialAccount(provider);
      setSocialAccounts((prev) => prev?.filter((a) => a.provider !== provider) ?? prev);
    } catch (err) {
      setDisconnectError(err instanceof Error ? err.message : `Couldn't disconnect ${PLATFORM_NAME[provider]}`);
    } finally {
      setDisconnectingProvider(null);
    }
  }

  function accountFor(provider: SocialProviderKey) {
    return socialAccounts?.find((a) => a.provider === provider) ?? null;
  }

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

      {!isLoadingRole && hasFeature("social_posting") && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Connected accounts</h2>
          <p className="text-sm text-muted">
            Connect a platform once, then post a finished reel there in one click from the library.
          </p>
          {socialNotice && <p className="text-sm text-accent">{socialNotice}</p>}
          {(socialError || disconnectError) && <p className="text-sm text-red-600">{socialError ?? disconnectError}</p>}

          {CONNECTABLE_PROVIDERS.map(({ key, label }) => {
            const account = accountFor(key);
            return (
              <div key={key} className="flex items-center justify-between rounded-md border border-border p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">{label}</p>
                  <p className="text-sm text-muted">{account ? `Connected as ${account.accountName}` : "Not connected"}</p>
                </div>
                {account ? (
                  <button
                    type="button"
                    onClick={() => handleDisconnect(key)}
                    disabled={disconnectingProvider === key}
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface disabled:opacity-50"
                  >
                    {disconnectingProvider === key ? "Disconnecting…" : "Disconnect"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleConnect(key)}
                    disabled={connectingProvider === key || socialAccounts === null}
                    className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {connectingProvider === key ? "Connecting…" : `Connect ${label}`}
                  </button>
                )}
              </div>
            );
          })}

          {/* Instagram is never connected directly -- a Facebook connect
              that has a linked Instagram Business account picks it up
              automatically (see backend/src/social/service.py's
              handle_callback), so this is status + disconnect only. */}
          {(() => {
            const instagramAccount = accountFor("instagram");
            return (
              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">Instagram</p>
                  <p className="text-sm text-muted">
                    {instagramAccount
                      ? `Connected as ${instagramAccount.accountName}`
                      : "Not connected -- connects automatically when you connect Facebook"}
                  </p>
                </div>
                {instagramAccount && (
                  <button
                    type="button"
                    onClick={() => handleDisconnect("instagram")}
                    disabled={disconnectingProvider === "instagram"}
                    className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface disabled:opacity-50"
                  >
                    {disconnectingProvider === "instagram" ? "Disconnecting…" : "Disconnect"}
                  </button>
                )}
              </div>
            );
          })()}
        </section>
      )}

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

// useSearchParams (above) requires a Suspense boundary -- same convention as
// library/page.tsx's own equivalent wrapper.
export default function SettingsPage() {
  return (
    <Suspense fallback={<main className="mx-auto w-full max-w-2xl px-4 py-12 text-sm text-muted">Loading…</main>}>
      <SettingsPageContent />
    </Suspense>
  );
}
