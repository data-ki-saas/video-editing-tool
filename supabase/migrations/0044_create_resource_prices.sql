-- Admin-set prices for each consumption item (see backend/src/pricing/
-- catalog.py for the item registry). Append-only history: changing a price
-- INSERTS a new row, and the current price is the newest row per
-- resource_key. effective_from defaults to the database clock, so a change
-- applies from the instant it is committed and never to earlier usage.
create table if not exists public.resource_prices (
    id uuid primary key default gen_random_uuid(),
    resource_key text not null,
    -- Price per catalog `per` units (1 second, 1 image, 1000 tokens...), in cents.
    unit_price_cents numeric(14, 6) not null check (unit_price_cents >= 0),
    effective_from timestamptz not null default now(),
    created_by uuid references public.users (id) on delete set null
);

create index if not exists resource_prices_key_time_idx
    on public.resource_prices (resource_key, effective_from desc);

alter table public.resource_prices enable row level security;
-- No policies -- service-role only, same convention as role_features (0015).

-- The price is SNAPSHOTTED onto each ledger row when the usage happens, so
-- later price changes can never rewrite what a past month was charged.
-- NULL on rows from before this migration (never priced) and on rows whose
-- price lookup failed (flagged, not guessed).
alter table public.usage_ledger
    add column if not exists resource_key text,
    add column if not exists unit_price_cents numeric(14, 6),
    add column if not exists charge_cents numeric(14, 6);

-- feature_key is validated against backend/src/permissions/features.py's
-- registry, not an FK -- see 0015's own comment on that choice.
insert into public.role_features (role_key, feature_key)
values ('admin', 'pricing_manage')
on conflict do nothing;
