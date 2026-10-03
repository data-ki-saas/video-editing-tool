// The site's own public production URL -- read from the `SITE_URL` env var (see
// DEPLOY.md's env var table) rather than a NEXT_PUBLIC_-prefixed copy: every file importing this one (root layout, the marketing home
// page, robots.ts, sitemap.ts) is a server component or a route handler, so
// a plain (non-public) env var is safe to read here -- it's serialized into
// the response Next.js builds server-side, never bundled into client JS.
// Falls back to the production custom domain so local/preview builds (where
// SITE_URL is typically unset, per DEPLOY.md) still get a real, absolute
// URL rather than a broken one.
export const SITE_URL = process.env.SITE_URL ?? "https://Myreels.in";
