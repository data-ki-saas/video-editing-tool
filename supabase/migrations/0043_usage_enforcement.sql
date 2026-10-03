-- Hard spend/abuse enforcement for the paid providers (fal.ai) and storage
-- (Cloudflare R2). Replaces the old read-count-then-act-then-insert daily-cap
-- pattern, which was racy (N concurrent requests all passed the count check
-- before any of them recorded an event) and fail-open.

-- 1. usage_events becomes the enforcement ledger: every reservation carries
--    the cost it is expected to incur, so a GLOBAL daily budget can be
--    enforced in the same atomic step as the per-user cap.
alter table public.usage_events
    add column if not exists cost_estimate_cents numeric(12, 6) not null default 0;

create index if not exists usage_events_type_time_idx
    on public.usage_events (event_type, created_at);

alter table public.usage_events drop constraint usage_events_event_type_check;
alter table public.usage_events add constraint usage_events_event_type_check
    check (event_type in (
        'render', 'voiceover', 'upload', 'avatar_video', 'background_removal',
        'ticket_filed', 'avatar_generate', 'ticket_message', 'library_publish'
    ));

-- cap_warnings.feature was pinned to four values in 0022 and never widened,
-- so every cap hit for avatar_generate / ticket_filed was silently failing to
-- insert (third occurrence of this bug class, see 0037). It is only a label,
-- so drop the constraint instead of widening it a fourth time.
alter table public.cap_warnings drop constraint if exists cap_warnings_feature_check;

-- 2. Atomic reserve-or-refuse. One global advisory lock serialises every
--    reservation (volume is tiny; correctness matters more), so the
--    count + budget check + insert below cannot interleave across requests.
--    p_user_cap / p_global_cap NULL = not enforced (admin bypass of the
--    per-user cap). The global budget is summed over ALL cost-bearing event
--    types, i.e. it is the one number that bounds the total fal.ai bill no
--    matter how many accounts exist.
create or replace function public.reserve_usage(
    p_user_id uuid,
    p_event_type text,
    p_user_cap int,
    p_global_cap int,
    p_window_seconds int,
    p_cost_cents numeric,
    p_global_budget_cents numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_since timestamptz := now() - make_interval(secs => p_window_seconds);
    v_user_count int;
    v_global_count int;
    v_global_cost numeric;
    v_event_id uuid;
begin
    perform pg_advisory_xact_lock(hashtext('reserve_usage'));

    select count(*) into v_user_count
    from usage_events
    where user_id = p_user_id and event_type = p_event_type and created_at >= v_since;

    if p_user_cap is not null and v_user_count >= p_user_cap then
        return jsonb_build_object('status', 'user_cap', 'user_count', v_user_count);
    end if;

    if p_global_cap is not null then
        select count(*) into v_global_count
        from usage_events
        where event_type = p_event_type and created_at >= v_since;
        if v_global_count >= p_global_cap then
            return jsonb_build_object('status', 'global_cap', 'global_count', v_global_count);
        end if;
    end if;

    if p_cost_cents > 0 and p_global_budget_cents is not null then
        select coalesce(sum(cost_estimate_cents), 0) into v_global_cost
        from usage_events
        where cost_estimate_cents > 0 and created_at >= v_since;
        if v_global_cost + p_cost_cents > p_global_budget_cents then
            return jsonb_build_object('status', 'global_budget', 'global_cost_cents', v_global_cost);
        end if;
    end if;

    insert into usage_events (user_id, event_type, cost_estimate_cents)
    values (p_user_id, p_event_type, p_cost_cents)
    returning id into v_event_id;

    return jsonb_build_object('status', 'ok', 'user_count', v_user_count + 1, 'event_id', v_event_id);
end;
$$;

revoke all on function public.reserve_usage(uuid, text, int, int, int, numeric, numeric) from public, anon, authenticated;
grant execute on function public.reserve_usage(uuid, text, int, int, int, numeric, numeric) to service_role;

-- 3. Per-user private-bucket footprint (assets + recordings + ticket
--    attachments), computed in SQL so it is not subject to PostgREST's
--    1000-row response cap. Rows sharing a deduped storage_key are each
--    counted -- deliberately conservative.
create or replace function public.user_storage_usage(p_user_id uuid) returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select jsonb_build_object(
        'bytes',
            coalesce((select sum(size_bytes) from assets where uploaded_by = p_user_id), 0)
          + coalesce((select sum(size_bytes) from recordings where user_id = p_user_id), 0)
          + coalesce((
                select sum(a.size_bytes)
                from support_ticket_attachments a
                join support_ticket_messages m on m.id = a.message_id
                where m.author_id = p_user_id
            ), 0),
        'objects',
            (select count(*) from assets where uploaded_by = p_user_id)
          + (select count(*) from recordings where user_id = p_user_id)
          + (
                select count(*)
                from support_ticket_attachments a
                join support_ticket_messages m on m.id = a.message_id
                where m.author_id = p_user_id
            )
    );
$$;

revoke all on function public.user_storage_usage(uuid) from public, anon, authenticated;
grant execute on function public.user_storage_usage(uuid) to service_role;

-- 4. Close client-side write paths that bypass the backend's accounting.
--    The anon key + a user's own JWT is enough to call PostgREST directly,
--    so any policy below is reachable by a script, not just by our UI.
--    - usage_events: a user inserting their own rows could flood the table.
--      Only the service role (reserve_usage) writes it now.
--    - projects DELETE / assets INSERT+DELETE: deleting these straight
--      through PostgREST cascades the DB rows away but never reaches R2, so
--      the objects stay (and cost money) while no row counts them against
--      any quota. Project/asset deletion is done by the backend, which
--      removes the R2 object (projects/service.py, assets/service.py).
drop policy if exists "Users can record their own usage events" on public.usage_events;
drop policy if exists "Users can delete their own projects" on public.projects;
drop policy if exists "Project owners can add assets" on public.assets;
drop policy if exists "Project owners can delete assets" on public.assets;
