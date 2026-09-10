-- Manually-logged top-ups for a pay-as-you-go provider account (fal.ai to
-- start) -- these providers don't expose a balance/billing API we can poll
-- (see admin/integrations page's own fal.ai note on this), so an admin
-- records each top-up here by hand after adding funds on the provider's own
-- dashboard. Paired with usage_ledger's own cost_estimate_cents for that
-- provider to compute remaining runway (see metering/service.py's
-- get_provider_runway) -- this table only ever holds the credit side.
create table if not exists public.provider_topups (
    id uuid primary key default gen_random_uuid(),
    -- A logical grouping key chosen by this app, not necessarily identical
    -- to usage_ledger.provider -- "fal" covers BOTH fal_rembg and fal_veed
    -- rows there, since both are billed through the same fal.ai account
    -- (see admin/integrations page's own note on this).
    provider text not null,
    amount_cents numeric(12, 2) not null check (amount_cents > 0),
    note text,
    created_by uuid references public.users (id) on delete set null,
    created_at timestamptz not null default now()
);

create index if not exists provider_topups_provider_idx on public.provider_topups (provider, created_at);

alter table public.provider_topups enable row level security;
-- No policies -- service-role only, same convention as usage_ledger (0016).
