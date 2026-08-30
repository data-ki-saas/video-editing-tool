-- Captured at render-request time (frontend/src/app/api/render/route.ts),
-- read back by the Creatomate webhook to log the render's usage_ledger
-- entry at completion -- Creatomate's own webhook payload doesn't include
-- duration (see webhooks/creatomate/route.ts's CreatomatePayload).
alter table public.projects
    add column if not exists render_output_duration_seconds numeric;
