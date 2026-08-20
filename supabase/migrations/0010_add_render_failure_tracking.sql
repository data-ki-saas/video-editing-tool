-- render_error carries a human-readable reason once render_status = 'failed'
-- -- populated by the Creatomate webhook (Creatomate-side failure) or by the
-- render-transfer worker (R2 mirror step failing after retries). render_
-- started_at marks when the CURRENT render attempt began, used purely as a
-- client-side heuristic (see useRenderStatus.ts's RENDER_STUCK_THRESHOLD_MS)
-- to warn the user when a render has been non-terminal far longer than
-- normal -- most often the worker crashing mid-transfer with nothing left to
-- retry it, a known gap called out in worker/src/server.js.
alter table public.projects
    add column if not exists render_error text,
    add column if not exists render_started_at timestamptz;
