import type { Metadata } from "next";
import { DashboardSidebar } from "@/components/DashboardSidebar";
import { EditorPanelProvider } from "@/lib/editor/EditorPanelContext";

// Requires auth (see src/lib/supabase/middleware.ts) -- noindex since crawlers would just hit a redirect.
export const metadata: Metadata = {
  title: "Dashboard",
  description: "Upload videos and edit your Reel timeline.",
  robots: { index: false, follow: false },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <EditorPanelProvider>
      <div className="flex h-screen bg-background text-foreground">
        <DashboardSidebar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </EditorPanelProvider>
  );
}
