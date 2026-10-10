-- Per-user prepaid credits for premium (paid-provider) features. First user:
-- Sarvam AI text-to-speech, metered in characters. Every account gets a
-- one-time trial grant so they can try it; after that, credits come from
-- top-ups (rows with reason 'topup', written once payment exists -- or by an
-- admin as 'adjustment'). Balance = sum(delta); the ledger is append-only.
create table if not exists public.user_credit_ledger (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete cascade,
    resource text not null check (resource in ('sarvam_tts_chars')),
    -- Signed: grants/top-ups/refunds positive, usage negative.
    delta bigint not null check (delta <> 0),
    reason text not null check (reason in ('trial_grant', 'topup', 'usage', 'refund', 'adjustment')),
    note text,
    created_at timestamptz not null default now()
);

create index if not exists user_credit_ledger_user_idx on public.user_credit_ledger (user_id, resource);

-- At most one trial grant per user per resource, enforced by the database.
create unique index if not exists user_credit_ledger_trial_once_idx
    on public.user_credit_ledger (user_id, resource) where reason = 'trial_grant';

alter table public.user_credit_ledger enable row level security;
-- No policies -- service-role only (a client must never write its own credits).

-- Idempotent trial grant; returns the balance after.
create or replace function public.ensure_trial_credits(p_user_id uuid, p_resource text, p_amount bigint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
begin
    perform pg_advisory_xact_lock(hashtext('credits:' || p_user_id::text));
    if p_amount > 0 then
        insert into user_credit_ledger (user_id, resource, delta, reason)
        values (p_user_id, p_resource, p_amount, 'trial_grant')
        on conflict do nothing;
    end if;
    return (select coalesce(sum(delta), 0) from user_credit_ledger where user_id = p_user_id and resource = p_resource);
end;
$$;

-- Atomic spend-or-refuse: the per-user advisory lock serialises concurrent
-- requests so two parallel syntheses cannot both spend the same credits.
create or replace function public.spend_credits(p_user_id uuid, p_resource text, p_amount bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_balance bigint;
begin
    perform pg_advisory_xact_lock(hashtext('credits:' || p_user_id::text));
    select coalesce(sum(delta), 0) into v_balance
    from user_credit_ledger where user_id = p_user_id and resource = p_resource;

    if v_balance < p_amount then
        return jsonb_build_object('status', 'insufficient', 'balance', v_balance);
    end if;

    insert into user_credit_ledger (user_id, resource, delta, reason)
    values (p_user_id, p_resource, -p_amount, 'usage');
    return jsonb_build_object('status', 'ok', 'balance', v_balance - p_amount);
end;
$$;

revoke all on function public.ensure_trial_credits(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.spend_credits(uuid, text, bigint) from public, anon, authenticated;

-- Sarvam voiceover is metered in characters, and gets its own enforcement
-- event type (daily cap + site-wide cost budget via reserve_usage).
alter table public.usage_ledger drop constraint usage_ledger_unit_check;
alter table public.usage_ledger add constraint usage_ledger_unit_check
    check (unit in ('seconds', 'tokens', 'images', 'megabytes', 'items', 'characters'));

alter table public.usage_events drop constraint usage_events_event_type_check;
alter table public.usage_events add constraint usage_events_event_type_check
    check (event_type in (
        'render', 'voiceover', 'upload', 'avatar_video', 'background_removal',
        'ticket_filed', 'avatar_generate', 'ticket_message', 'library_publish',
        'voiceover_sarvam'
    ));

-- Sarvam returns WAV, stored as a project asset like the edge-tts mp3s.
alter table public.assets drop constraint if exists assets_mime_type_check;
alter table public.assets add constraint assets_mime_type_check
    check (mime_type in ('video/mp4', 'image/jpeg', 'image/png', 'audio/mpeg', 'audio/wav'));
