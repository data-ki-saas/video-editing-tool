import type { Metadata } from "next";

// Requires auth (see src/lib/supabase/middleware.ts) -- noindex since crawlers would just hit a redirect.
export const metadata: Metadata = {
  title: "Dashboard",
  description: "Upload videos and edit your Reel timeline.",
  robots: { index: false, follow: false },
};

// No left sidebar here on purpose -- project switching now lives inside the
// editor's Action Area (see components/editor-v2/ProjectList.tsx). Settings/
// sign-out used to live in a persistent top bar here, but that ate a
// full-width row of vertical space from every /dashboard/[projectId] visit;
// moved into FeedbackArea's own corner instead. Bare /dashboard and
// /dashboard/new, which aren't short on space, keep a top bar via the
// (chrome) route group.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex h-screen flex-col bg-background text-foreground">{children}</div>;
}
