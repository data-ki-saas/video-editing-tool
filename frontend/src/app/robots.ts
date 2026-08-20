import type { MetadataRoute } from "next";

const SITE_URL = "https://video-editing-tool-gamma.vercel.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // /dashboard and /settings require auth (see src/lib/supabase/middleware.ts)
      // -- an unauthenticated crawler would just be bounced to /login anyway.
      disallow: ["/dashboard", "/settings"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
