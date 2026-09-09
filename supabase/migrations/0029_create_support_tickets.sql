-- Support ticketing: a user files a ticket (subject + body + up to 5
-- attachments), an admin (or anyone whose role grants tickets_manage_all --
-- see 0015's role_features) triages and replies, the filer sees the
-- resulting thread. Reachable via the Support icon in GlobalTopNav.tsx, left
-- of Account.
--
-- Three tables: a ticket "header" (triage metadata), its messages, and each
-- message's attachments -- the ticket's own opening message is just the
-- first row in support_ticket_messages, not a separate `body` column on
-- support_tickets itself, so the thread view never has to special-case "the
-- first message."
create table if not exists public.support_tickets (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete cascade,
    subject text not null check (char_length(subject) between 1 and 200),
    -- Chosen by the filer at creation time (defaults to the least-alarming
    -- option); re-triaged by an admin afterward via PATCH .../triage.
    priority text not null default 'low' check (priority in ('critical', 'high', 'low')),
    -- Admin-only triage field, unset until an admin classifies it -- never
    -- shown on the filing form (see support/page.tsx's own comment on why
    -- this is deliberately not a filer-facing concept).
    layer text check (layer in ('frontend', 'backend', 'database', 'storage')),
    state text not null default 'new' check (state in ('new', 'seen', 'assigned', 'resolved')),
    -- Which admin/agent (a user whose role grants tickets_manage_all) is on
    -- it -- null means unassigned. set null on delete rather than cascade:
    -- losing the assignee account shouldn't delete the ticket itself.
    assigned_to uuid references public.users (id) on delete set null,
    -- The filer's own "have I seen the latest reply" marker -- independent
    -- of `state`, which instead tracks ADMIN attention (new -> seen is
    -- auto-set the first time an admin opens the ticket). See
    -- backend/src/tickets/service.py's get_ticket_detail.
    user_last_viewed_at timestamptz,
    -- Auto-captured client-side on filing (never a form field the filer
    -- fills in) -- which project/browser they were on, purely to save an
    -- admin from having to ask. Shown only in the admin thread view.
    context_project_id uuid references public.projects (id) on delete set null,
    context_user_agent text,
    created_at timestamptz not null default now(),
    -- Bumped by application code (no DB trigger -- see backend/src/tickets/
    -- repository.py) on every new message and every triage change; doubles
    -- as the "recent activity" sort key for both the filer's own list and
    -- the admin queue.
    updated_at timestamptz not null default now()
);

create index if not exists support_tickets_user_time_idx
    on public.support_tickets (user_id, updated_at desc);
create index if not exists support_tickets_state_time_idx
    on public.support_tickets (state, updated_at desc);

create table if not exists public.support_ticket_messages (
    id uuid primary key default gen_random_uuid(),
    ticket_id uuid not null references public.support_tickets (id) on delete cascade,
    author_id uuid not null references public.users (id),
    is_admin_reply boolean not null default false,
    -- An internal note (admin-only, never sent to the filer) vs. a comment
    -- (customer-visible, same as any reply). Unrepresentable for a
    -- non-admin message -- see backend/src/tickets/service.py's add_message,
    -- which forces this false for anyone who isn't posting as an admin.
    is_internal boolean not null default false check (not is_internal or is_admin_reply),
    body text not null default '',
    created_at timestamptz not null default now()
);

create index if not exists support_ticket_messages_ticket_time_idx
    on public.support_ticket_messages (ticket_id, created_at);

create table if not exists public.support_ticket_attachments (
    id uuid primary key default gen_random_uuid(),
    message_id uuid not null references public.support_ticket_messages (id) on delete cascade,
    filename text not null,
    mime_type text not null,
    size_bytes int not null,
    -- Private-uploads-bucket key (see backend/src/storage/r2_client.py) --
    -- read back via a presigned URL, same convention as assets.storage_key.
    -- No delete endpoint exists for a ticket/message/attachment, so unlike
    -- `assets` there's no reference-counting cleanup needed here.
    storage_key text not null,
    created_at timestamptz not null default now()
);

alter table public.support_tickets enable row level security;
alter table public.support_ticket_messages enable row level security;
alter table public.support_ticket_attachments enable row level security;

-- Backend-owned like recordings/scripts/library_videos: only the service
-- role (which bypasses RLS) actually writes these tables. Select-own is
-- included for defense-in-depth/future direct-read use, same precedent as
-- every other table above -- note the messages/attachments policies also
-- exclude internal notes for a non-admin direct reader, matching the
-- backend's own filtering in tickets/service.py.
create policy "Ticket owners can view their own tickets"
    on public.support_tickets for select using (auth.uid() = user_id);

create policy "Ticket owners can view their own non-internal messages"
    on public.support_ticket_messages for select using (
        not is_internal
        and exists (
            select 1 from public.support_tickets
            where support_tickets.id = support_ticket_messages.ticket_id
            and support_tickets.user_id = auth.uid()
        )
    );

create policy "Ticket owners can view their own non-internal attachments"
    on public.support_ticket_attachments for select using (
        exists (
            select 1 from public.support_ticket_messages
            join public.support_tickets on support_tickets.id = support_ticket_messages.ticket_id
            where support_ticket_messages.id = support_ticket_attachments.message_id
            and support_ticket_messages.is_internal = false
            and support_tickets.user_id = auth.uid()
        )
    );

-- Grants the new admin-only "view/respond to everyone's tickets" capability
-- to the admin role, same seeding convention as 0015's own role_features
-- inserts. The feature key itself is declared in
-- backend/src/permissions/features.py, not a DB table -- see that file's
-- own comment on why.
insert into public.role_features (role_key, feature_key)
values ('admin', 'tickets_manage_all')
on conflict do nothing;

-- Widen usage_events (0006/0013/0019) to cover the new abuse-rate-limit cap
-- on filing a ticket (backend/src/tickets/service.py's create_ticket,
-- TICKETS_DAILY_CAP) -- same drop-and-recreate pattern those migrations
-- already established.
alter table public.usage_events drop constraint usage_events_event_type_check;
alter table public.usage_events add constraint usage_events_event_type_check
    check (event_type in ('render', 'voiceover', 'upload', 'avatar_video', 'background_removal', 'ticket_filed'));
