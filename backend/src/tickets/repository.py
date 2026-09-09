import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from src.core.supabase_client import get_supabase_client

logger = logging.getLogger(__name__)

_TICKETS_TABLE = "support_tickets"
_MESSAGES_TABLE = "support_ticket_messages"
_ATTACHMENTS_TABLE = "support_ticket_attachments"
_USAGE_EVENTS_TABLE = "usage_events"
_TICKET_EVENT_TYPE = "ticket_filed"


@dataclass
class TicketRecord:
    id: str
    user_id: str
    subject: str
    priority: str
    layer: str | None
    state: str
    assigned_to: str | None
    user_last_viewed_at: str | None
    context_project_id: str | None
    context_user_agent: str | None
    created_at: str
    updated_at: str


@dataclass
class MessageRecord:
    id: str
    ticket_id: str
    author_id: str
    is_admin_reply: bool
    is_internal: bool
    body: str
    created_at: str


@dataclass
class AttachmentRecord:
    id: str
    message_id: str
    filename: str
    mime_type: str
    size_bytes: int
    storage_key: str
    created_at: str


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def create_ticket(
    *, user_id: str, subject: str, priority: str, context_project_id: str | None, context_user_agent: str | None
) -> TicketRecord:
    payload = {
        "user_id": user_id,
        "subject": subject,
        "priority": priority,
        "context_project_id": context_project_id,
        "context_user_agent": context_user_agent,
    }
    result = get_supabase_client().table(_TICKETS_TABLE).insert(payload).execute()
    return TicketRecord(**result.data[0])


def get_ticket(ticket_id: str) -> TicketRecord | None:
    result = get_supabase_client().table(_TICKETS_TABLE).select("*").eq("id", ticket_id).limit(1).execute()
    return TicketRecord(**result.data[0]) if result.data else None


def list_tickets_for_user(user_id: str) -> list[TicketRecord]:
    """Newest-activity first -- support_tickets_user_time_idx (0029) makes
    this a straight index scan, not a sort."""
    result = (
        get_supabase_client()
        .table(_TICKETS_TABLE)
        .select("*")
        .eq("user_id", user_id)
        .order("updated_at", desc=True)
        .execute()
    )
    return [TicketRecord(**row) for row in result.data or []]


def list_tickets_admin(
    *, state: str | None, priority: str | None, layer: str | None, assigned_to: str | None
) -> list[TicketRecord]:
    query = get_supabase_client().table(_TICKETS_TABLE).select("*")
    if state:
        query = query.eq("state", state)
    if priority:
        query = query.eq("priority", priority)
    if layer:
        query = query.eq("layer", layer)
    if assigned_to:
        query = query.eq("assigned_to", assigned_to)
    result = query.order("updated_at", desc=True).execute()
    return [TicketRecord(**row) for row in result.data or []]


def count_new_tickets() -> int:
    result = get_supabase_client().table(_TICKETS_TABLE).select("id", count="exact").eq("state", "new").execute()
    return result.count or 0


def update_triage(ticket_id: str, **fields) -> TicketRecord | None:
    """Partial update -- `fields` only ever contains keys the caller
    (tickets/service.py's set_triage) actually changed. Always re-stamps
    updated_at itself since this repo has no DB trigger for it (see
    supabase/migrations/0029's own comment)."""
    payload = {**fields, "updated_at": _now_iso()}
    result = get_supabase_client().table(_TICKETS_TABLE).update(payload).eq("id", ticket_id).execute()
    return TicketRecord(**result.data[0]) if result.data else None


def touch_updated_at(ticket_id: str) -> None:
    get_supabase_client().table(_TICKETS_TABLE).update({"updated_at": _now_iso()}).eq("id", ticket_id).execute()


def mark_seen(ticket_id: str) -> None:
    """new -> seen only -- the extra .eq("state", "new") makes this a no-op
    once the ticket has moved past `new`, so it can never clobber
    `assigned`/`resolved` even under a race with an admin's own triage
    change."""
    get_supabase_client().table(_TICKETS_TABLE).update({"state": "seen"}).eq("id", ticket_id).eq(
        "state", "new"
    ).execute()


def mark_viewed_by_owner(ticket_id: str) -> None:
    get_supabase_client().table(_TICKETS_TABLE).update({"user_last_viewed_at": _now_iso()}).eq(
        "id", ticket_id
    ).execute()


def create_message(*, ticket_id: str, author_id: str, is_admin_reply: bool, is_internal: bool, body: str) -> MessageRecord:
    payload = {
        "ticket_id": ticket_id,
        "author_id": author_id,
        "is_admin_reply": is_admin_reply,
        "is_internal": is_internal,
        "body": body,
    }
    result = get_supabase_client().table(_MESSAGES_TABLE).insert(payload).execute()
    return MessageRecord(**result.data[0])


def list_messages_with_attachments(
    ticket_id: str, *, include_internal: bool
) -> list[tuple[MessageRecord, list[AttachmentRecord]]]:
    """The include_internal=False path (every non-admin read) filters
    is_internal out IN THE QUERY -- an internal note's body/attachments
    never leave the database for a non-admin caller, not just hidden by the
    frontend."""
    query = get_supabase_client().table(_MESSAGES_TABLE).select("*").eq("ticket_id", ticket_id)
    if not include_internal:
        query = query.eq("is_internal", False)
    messages_result = query.order("created_at").execute()
    messages = [MessageRecord(**row) for row in messages_result.data or []]
    if not messages:
        return []

    message_ids = [m.id for m in messages]
    attachments_result = get_supabase_client().table(_ATTACHMENTS_TABLE).select("*").in_("message_id", message_ids).execute()
    attachments_by_message: dict[str, list[AttachmentRecord]] = {}
    for row in attachments_result.data or []:
        record = AttachmentRecord(**row)
        attachments_by_message.setdefault(record.message_id, []).append(record)

    return [(m, attachments_by_message.get(m.id, [])) for m in messages]


def count_messages(ticket_id: str, *, include_internal: bool) -> int:
    query = get_supabase_client().table(_MESSAGES_TABLE).select("id", count="exact").eq("ticket_id", ticket_id)
    if not include_internal:
        query = query.eq("is_internal", False)
    result = query.execute()
    return result.count or 0


def latest_customer_visible_message_at(ticket_id: str) -> str | None:
    """Feeds has_unread (tickets/service.py) -- the newest message the
    FILER is even allowed to see, i.e. always excludes internal notes
    regardless of who's asking."""
    result = (
        get_supabase_client()
        .table(_MESSAGES_TABLE)
        .select("created_at")
        .eq("ticket_id", ticket_id)
        .eq("is_internal", False)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    return result.data[0]["created_at"] if result.data else None


def create_attachment(*, message_id: str, filename: str, mime_type: str, size_bytes: int, storage_key: str) -> AttachmentRecord:
    payload = {
        "message_id": message_id,
        "filename": filename,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "storage_key": storage_key,
    }
    result = get_supabase_client().table(_ATTACHMENTS_TABLE).insert(payload).execute()
    return AttachmentRecord(**result.data[0])


def get_users_basic(user_ids: list[str]) -> dict[str, dict]:
    """Batched lookup for submitter/assignee email+display_name, same table
    permissions/repository.py's get_user_basic reads one row at a time from."""
    ids = list({uid for uid in user_ids if uid})
    if not ids:
        return {}
    result = get_supabase_client().table("users").select("id, email, display_name").in_("id", ids).execute()
    return {row["id"]: row for row in result.data or []}


def list_assignable_admins() -> list[dict]:
    """Users whose CURRENT role grants tickets_manage_all -- resolved from
    role_features (same table permissions/repository.py already reads) since
    roles are admin-creatable (0015), so "admin" isn't the only role this
    could ever be true for. Same two-step/left-embed shape
    permissions_repository.list_users uses, just pre-filtered here instead
    of listing every signed-up user."""
    role_result = get_supabase_client().table("role_features").select("role_key").eq("feature_key", "tickets_manage_all").execute()
    role_keys = {row["role_key"] for row in role_result.data or []}
    if not role_keys:
        return []

    result = get_supabase_client().table("users").select("id, email, display_name, profiles(role)").execute()
    admins = []
    for row in result.data or []:
        profile = row.get("profiles")
        role_key = profile["role"] if profile else None
        if role_key in role_keys:
            admins.append({"id": row["id"], "email": row.get("email"), "display_name": row.get("display_name")})
    return admins


def get_project_name(project_id: str) -> str | None:
    result = get_supabase_client().table("projects").select("name").eq("id", project_id).limit(1).execute()
    return result.data[0]["name"] if result.data else None


def count_recent_ticket_events(user_id: str) -> int | None:
    """Fail-OPEN on a read error (returns None), same convention as
    tts/repository.py's count_recent_voiceover_events -- a usage_events
    hiccup shouldn't block filing a ticket entirely."""
    since = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
    try:
        result = (
            get_supabase_client()
            .table(_USAGE_EVENTS_TABLE)
            .select("id", count="exact")
            .eq("user_id", user_id)
            .eq("event_type", _TICKET_EVENT_TYPE)
            .gte("created_at", since)
            .execute()
        )
    except Exception:
        logger.exception("failed to count ticket usage events for user=%s", user_id)
        return None
    return result.count or 0


def record_ticket_event(user_id: str) -> None:
    """Best-effort usage record for the rate-limit check above -- a failure
    here shouldn't fail a ticket that was already created."""
    try:
        get_supabase_client().table(_USAGE_EVENTS_TABLE).insert({"user_id": user_id, "event_type": _TICKET_EVENT_TYPE}).execute()
    except Exception:
        logger.exception("failed to record ticket usage event for user=%s", user_id)
