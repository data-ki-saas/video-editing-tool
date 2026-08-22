import type { Metadata } from "next";
import { SignOutButton } from "@/components/SignOutButton";

// Requires auth (see src/lib/supabase/middleware.ts) -- noindex since crawlers would just hit a redirect.
export const metadata: Metadata = {
  title: "Dashboard",
  description: "Upload videos and edit your Reel timeline.",
  robots: { index: false, follow: false },
};

// No left sidebar here on purpose -- project switching now lives inside the
// editor's Action Area (see components/editor-v2/ProjectList.tsx). This top
// bar exists just to keep sign-out reachable from every /dashboard page.
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <div className="flex shrink-0 items-center justify-end border-b border-border px-4 py-2">
        <SignOutButton />
      </div>
      <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
