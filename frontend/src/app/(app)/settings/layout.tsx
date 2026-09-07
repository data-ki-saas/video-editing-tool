import type { Metadata } from "next";

// Requires auth (see src/lib/supabase/middleware.ts) -- noindex since
// crawlers would just hit a redirect.
export const metadata: Metadata = {
  title: "Settings",
  description: "Manage your Reel Creator account.",
  robots: { index: false, follow: false },
};

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen">{children}</div>;
}
