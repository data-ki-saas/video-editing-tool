import type { Metadata } from "next";

// Requires auth (see src/lib/supabase/middleware.ts) -- noindex since crawlers would just hit a redirect.
export const metadata: Metadata = {
  title: "Dashboard",
  description: "Upload videos and edit your Reel timeline.",
  robots: { index: false, follow: false },
};

// No sidebar here on purpose -- project switching now lives inside the
// editor's Action Area (see components/editor-v2/ProjectList.tsx), not as a
// persistent full-height column.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <main className="flex h-screen flex-col overflow-y-auto bg-background text-foreground">{children}</main>;
}
