import type { Metadata } from "next";

// Requires auth (see src/lib/supabase/middleware.ts) -- noindex since crawlers would just hit a redirect.
export const metadata: Metadata = {
  title: "Dashboard",
  description: "Upload videos and edit your Reel timeline.",
  robots: { index: false, follow: false },
};

// No left sidebar here on purpose -- project switching now lives inside the
// editor's Action Area (see components/editor-v2/ProjectList.tsx). The nav
// bar (Library/Settings/sign-out/etc.) lives one level up, in
// app/(app)/layout.tsx's GlobalTopNav, shared with every other authenticated
// page -- this div is just the h-full flex column /dashboard/[projectId]'s
// 3-pane editor fills (h-full, not h-screen: that nav bar already claims
// its own slice of the real 100vh above this).
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full flex-col bg-background text-foreground">{children}</div>;
}
