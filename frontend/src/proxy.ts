import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Excludes any path whose last segment has a file extension (public/
  // static assets), not just an enumerated image list -- that list missed
  // .mp3 and silently 307'd every hero-carousel audio request to /login for
  // signed-out visitors (i.e. everyone hitting the marketing homepage).
  // Extension-based exclusion avoids the same gap recurring for the next
  // static-asset type (fonts, video, pdf, ...) added under public/.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.\\w+$).*)"],
};
