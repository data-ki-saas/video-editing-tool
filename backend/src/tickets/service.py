import logging
import re
import tempfile
import uuid
from pathlib import Path

from fastapi import HTTPException, UploadFile

from src.core.auth import CurrentUser, bypasses_daily_caps
from src.core.config import settings
from src.metering import service as metering_service
from src.storage import r2_client
from src.tickets import repository
from src.tickets.schemas import (
    AssignableAdmin,
    AttachmentInfo,
    MessageInfo,
    TicketDetail,
    TicketSummary,
    TriageRequest,
)

logger = logging.getLogger(__name__)

MAX_ATTACHMENTS = 5
MAX_ATTACHMENT_SIZE_BYTES = 2 * 1024 * 1024

# Images + PDF only -- the class of evidence a support attachment realistic-
# ally is (a screenshot, a small log/invoice), and the only thing that fits
# sanely under a 2MB cap. Widen this if a real need for other types shows up.
_ALLOWED_ATTACHMENT_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"}
_UNSAFE_FILENAME_CHARS = re.compile(r"[^a-zA-Z0-9._-]")

_TICKET_PRIORITIES = ("critical", "high", "low")


def _is_admin(user: CurrentUser) -> bool:
    return "tickets_manage_all" in user.features


def _validate_attachment_count(files: list[UploadFile]) -> None:
    if len(files) > MAX_ATTACHMENTS:
        raise HTTPException(status_code=400, detail=f"You can attach at most {MAX_ATTACHMENTS} files")


async def _store_attachment(*, ticket_id: str, message_id: str, file: UploadFile) -> None:
    if file.content_type not in _ALLOWED_ATTACHMENT_TYPES or not file.filename:
        raise HTTPException(status_code=400, detail=f"Unsupported attachment type: {file.content_type}")

    body = await file.read()
    if not body:
        raise HTTPException(status_code=400, detail=f"{file.filename} is empty")
    if len(body) > MAX_ATTACHMENT_SIZE_BYTES:
        raise HTTPException(status_code=413, detail=f"{file.filename} exceeds the 2 MB attachment limit")

    safe_filename = _UNSAFE_FILENAME_CHARS.sub("_", file.filename)
    storage_key = f"tickets/{ticket_id}/{uuid.uuid4().hex}-{safe_filename}"

    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp.write(body)
        tmp_path = Path(tmp.name)
    try:
        r2_client.upload_file(tmp_path, storage_key, file.content_type)
    except Exception as exc:
        logger.exception("ticket attachment failed to write to R2: ticket=%s filename=%r", ticket_id, file.filename)
        raise HTTPException(status_code=502, detail="Failed to store an attachment") from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    repository.create_attachment(
        message_id=message_id, filename=file.filename, mime_type=file.content_type, size_bytes=len(body), storage_key=storage_key
    )


def _to_attachment_info(attachment: repository.AttachmentRecord) -> AttachmentInfo:
    return AttachmentInfo(
        id=attachment.id,
        filename=attachment.filename,
        mime_type=attachment.mime_type,
        size_bytes=attachment.size_bytes,
        url=r2_client.presigned_get_url(attachment.storage_key),
        created_at=attachment.created_at,
    )


def _to_message_info(message: repository.MessageRecord, attachments: list[repository.AttachmentRecord]) -> MessageInfo:
    return MessageInfo(
        id=message.id,
        author_id=message.author_id,
        is_admin_reply=message.is_admin_reply,
        is_internal=message.is_internal,
        body=message.body,
        attachments=[_to_attachment_info(a) for a in attachments],
        created_at=message.created_at,
    )


def _has_unread(ticket: repository.TicketRecord) -> bool:
    """True when the filer has something they haven't seen yet -- compares
    the newest customer-visible message against user_last_viewed_at (never
    an internal note, regardless of who's asking; see
    repository.latest_customer_visible_message_at)."""
    latest = repository.latest_customer_visible_message_at(ticket.id)
    if latest is None:
        return False
    if ticket.user_last_viewed_at is None:
        return True
    return latest > ticket.user_last_viewed_at


def _summary_fields(ticket: repository.TicketRecord, *, message_count: int) -> dict:
    return dict(
        id=ticket.id,
        subject=ticket.subject,
        priority=ticket.priority,
        layer=ticket.layer,
        state=ticket.state,
        assigned_to=ticket.assigned_to,
        has_unread=_has_unread(ticket),
        created_at=ticket.created_at,
        updated_at=ticket.updated_at,
        message_count=message_count,
    )


def _to_ticket_summary(
    ticket: repository.TicketRecord, *, users_basic: dict[str, dict] | None = None, message_count: int | None = None
) -> TicketSummary:
    """`users_basic` (a pre-batched submitter_id/assigned_to -> {email,
    display_name} lookup) is only ever passed by an admin-facing caller --
    see list_all_tickets_admin (whole-list batch) and _to_ticket_detail
    (single-ticket batch) below. Left None, submitter/assignee fields stay
    None too -- exactly what list_my_tickets wants, since a user doesn't
    need their own email echoed back on their own ticket."""
    if message_count is None:
        message_count = repository.count_messages(ticket.id, include_internal=False)

    submitter_email = submitter_display_name = None
    assignee_email = assignee_display_name = None
    if users_basic is not None:
        submitter = users_basic.get(ticket.user_id)
        if submitter:
            submitter_email = submitter.get("email")
            submitter_display_name = submitter.get("display_name")
        if ticket.assigned_to:
            assignee = users_basic.get(ticket.assigned_to)
            if assignee:
                assignee_email = assignee.get("email")
                assignee_display_name = assignee.get("display_name")

    return TicketSummary(
        **_summary_fields(ticket, message_count=message_count),
        submitter_email=submitter_email,
        submitter_display_name=submitter_display_name,
        assignee_email=assignee_email,
        assignee_display_name=assignee_display_name,
    )


def _to_ticket_detail(ticket: repository.TicketRecord, *, include_internal: bool, include_admin_fields: bool) -> TicketDetail:
    rows = repository.list_messages_with_attachments(ticket.id, include_internal=include_internal)
    messages = [_to_message_info(m, attachments) for m, attachments in rows]

    users_basic = None
    context_project_name = None
    context_user_agent = None
    if include_admin_fields:
        user_ids = [ticket.user_id] + ([ticket.assigned_to] if ticket.assigned_to else [])
        users_basic = repository.get_users_basic(user_ids)
        if ticket.context_project_id:
            context_project_name = repository.get_project_name(ticket.context_project_id)
        context_user_agent = ticket.context_user_agent

    summary = _to_ticket_summary(ticket, users_basic=users_basic, message_count=len(messages))
    return TicketDetail(**summary.model_dump(), messages=messages, context_project_name=context_project_name, context_user_agent=context_user_agent)


async def create_ticket(
    *,
    user: CurrentUser,
    subject: str,
    body: str,
    priority: str,
    files: list[UploadFile],
    context_project_id: str | None,
    context_user_agent: str | None,
) -> TicketDetail:
    subject = subject.strip()
    body = body.strip()
    if not subject:
        raise HTTPException(status_code=400, detail="Subject is required")
    if not body:
        raise HTTPException(status_code=400, detail="Please describe the issue")
    if priority not in _TICKET_PRIORITIES:
        raise HTTPException(status_code=400, detail=f"Invalid priority: {priority}")
    _validate_attachment_count(files)

    # Abuse guardrail on FILING (not replying) -- see core/config.py's
    # tickets_daily_cap and CLAUDE.md's abuse-rate-limiting scope note.
    # Admins skip it entirely, same as every other daily cap in this app.
    if not bypasses_daily_caps(user):
        recent_count = repository.count_recent_ticket_events(user.id)
        if recent_count is not None and recent_count >= settings.tickets_daily_cap:
            metering_service.record_cap_hit(
                user_id=user.id, feature="ticket_filed", cap_value=settings.tickets_daily_cap, count_at_trigger=recent_count + 1
            )
            raise HTTPException(
                status_code=429,
                detail=f"You've reached the limit of {settings.tickets_daily_cap} support tickets per day. Try again tomorrow.",
            )

    ticket = repository.create_ticket(
        user_id=user.id,
        subject=subject,
        priority=priority,
        context_project_id=context_project_id or None,
        context_user_agent=context_user_agent or None,
    )
    message = repository.create_message(ticket_id=ticket.id, author_id=user.id, is_admin_reply=False, is_internal=False, body=body)
    for file in files:
        await _store_attachment(ticket_id=ticket.id, message_id=message.id, file=file)

    # Recorded only after everything above actually succeeded -- a failed
    # filing attempt shouldn't count against the cap.
    repository.record_ticket_event(user.id)

    return get_ticket_detail(ticket.id, user)


async def add_message(*, ticket_id: str, user: CurrentUser, body: str, files: list[UploadFile], is_internal: bool = False) -> TicketDetail:
    ticket = repository.get_ticket(ticket_id)
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket not found")

    is_owner = ticket.user_id == user.id
    is_admin = _is_admin(user)
    if not is_owner and not is_admin:
        raise HTTPException(status_code=404, detail="Ticket not found")

    # A non-admin can never post an internal note, regardless of what was
    # sent -- never trust a client-supplied flag for something this
    # sensitive.
    is_admin_reply = not is_owner
    if not is_admin_reply:
        is_internal = False

    body = body.strip()
    _validate_attachment_count(files)
    if not body and not files:
        raise HTTPException(status_code=400, detail="Write a message or attach a file")

    message = repository.create_message(
        ticket_id=ticket_id, author_id=user.id, is_admin_reply=is_admin_reply, is_internal=is_internal, body=body
    )
    for file in files:
        await _store_attachment(ticket_id=ticket_id, message_id=message.id, file=file)

    # A resolved ticket must not silently stay resolved once the owner has
    # something new to say -- an admin's own message never changes state.
    if ticket.state == "resolved" and is_owner:
        repository.update_triage(ticket_id, state="new")
    else:
        repository.touch_updated_at(ticket_id)

    return get_ticket_detail(ticket_id, user)


def get_ticket_detail(ticket_id: str, user: CurrentUser) -> TicketDetail:
    ticket = repository.get_ticket(ticket_id)
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket not found")

    is_owner = ticket.user_id == user.id
    is_admin = _is_admin(user)
    if not is_owner and not is_admin:
        raise HTTPException(status_code=404, detail="Ticket not found")

    if is_owner:
        repository.mark_viewed_by_owner(ticket_id)
    if is_admin and ticket.state == "new":
        repository.mark_seen(ticket_id)
        ticket = repository.get_ticket(ticket_id) or ticket

    return _to_ticket_detail(ticket, include_internal=is_admin, include_admin_fields=is_admin)


def list_my_tickets(user: CurrentUser) -> list[TicketSummary]:
    return [_to_ticket_summary(t) for t in repository.list_tickets_for_user(user.id)]


def list_all_tickets_admin(
    *, state: str | None, priority: str | None, layer: str | None, assigned_to: str | None
) -> list[TicketSummary]:
    tickets = repository.list_tickets_admin(state=state, priority=priority, layer=layer, assigned_to=assigned_to)
    # One batched lookup for the whole list rather than one per ticket --
    # get_users_basic already exists for exactly this (see its own comment).
    user_ids: list[str] = []
    for t in tickets:
        user_ids.append(t.user_id)
        if t.assigned_to:
            user_ids.append(t.assigned_to)
    users_basic = repository.get_users_basic(user_ids)
    return [_to_ticket_summary(t, users_basic=users_basic) for t in tickets]


def get_unread_count(user: CurrentUser) -> int:
    return sum(1 for t in repository.list_tickets_for_user(user.id) if _has_unread(t))


def get_new_count() -> int:
    return repository.count_new_tickets()


def list_assignees() -> list[AssignableAdmin]:
    return [AssignableAdmin(**row) for row in repository.list_assignable_admins()]


def set_triage(ticket_id: str, body: TriageRequest) -> TicketDetail:
    ticket = repository.get_ticket(ticket_id)
    if ticket is None:
        raise HTTPException(status_code=404, detail="Ticket not found")

    fields = body.model_dump(exclude_unset=True)
    # state/priority/layer are non-nullable columns -- a client sending an
    # explicit `null` for one of these (never done by this app's own
    # frontend) would otherwise 500 on the write; drop rather than crash.
    # assigned_to is deliberately excluded here since null is its valid
    # "unassign" value.
    for key in ("state", "priority", "layer"):
        if fields.get(key) is None and key in fields:
            fields.pop(key)

    if not fields:
        return _to_ticket_detail(ticket, include_internal=True, include_admin_fields=True)

    # Assigning someone IS what "assigned" means -- bundle the state flip
    # into the same write unless the caller already sent an explicit state,
    # and never touch an already-resolved ticket.
    if fields.get("assigned_to") and "state" not in fields and ticket.state in ("new", "seen"):
        fields["state"] = "assigned"

    updated = repository.update_triage(ticket_id, **fields)
    if updated is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return _to_ticket_detail(updated, include_internal=True, include_admin_fields=True)
