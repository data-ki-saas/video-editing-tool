from typing import Literal

from pydantic import BaseModel

TicketPriority = Literal["critical", "high", "low"]
TicketLayer = Literal["frontend", "backend", "database", "storage"]
TicketState = Literal["new", "seen", "assigned", "resolved"]


class AttachmentInfo(BaseModel):
    id: str
    filename: str
    mime_type: str
    size_bytes: int
    # A presigned R2 URL, valid for settings.r2_signed_url_expires_seconds --
    # same not-a-permanent-link convention as assets.AssetInfo.url.
    url: str
    created_at: str


class MessageInfo(BaseModel):
    id: str
    author_id: str
    is_admin_reply: bool
    # True only for an admin-authored internal note (never sent to a
    # non-admin caller -- see tickets/service.py's list_messages_with_attachments
    # call sites). Always false for a user's own message.
    is_internal: bool
    body: str
    attachments: list[AttachmentInfo]
    created_at: str


class TicketSummary(BaseModel):
    id: str
    subject: str
    priority: TicketPriority
    layer: TicketLayer | None
    state: TicketState
    assigned_to: str | None
    # Computed, not stored -- see tickets/service.py's own comment on how
    # this compares user_last_viewed_at against the newest customer-visible
    # message. Always false on a response built for an admin caller (this
    # is the FILER's own read-state, not the admin's).
    has_unread: bool
    created_at: str
    updated_at: str
    message_count: int
    # Populated only when the caller is admin -- both on the admin queue
    # LIST (so it can show who filed each ticket without a detail fetch)
    # and the detail view; None for a response built for the ticket's own
    # owner, who already knows who they are. See tickets/service.py's
    # _to_ticket_summary/list_all_tickets_admin.
    submitter_email: str | None = None
    submitter_display_name: str | None = None
    assignee_email: str | None = None
    assignee_display_name: str | None = None


class TicketDetail(TicketSummary):
    messages: list[MessageInfo]
    context_project_name: str | None = None
    context_user_agent: str | None = None


class TicketsListResponse(BaseModel):
    tickets: list[TicketSummary]


class TicketCountResponse(BaseModel):
    count: int


class AssignableAdmin(BaseModel):
    id: str
    email: str | None
    display_name: str | None


class AssignableAdminsResponse(BaseModel):
    admins: list[AssignableAdmin]


class AddMessageRequest(BaseModel):
    """Not actually used as a FastAPI body model -- POST /{id}/messages takes
    multipart Form fields (body text alongside file uploads), same as
    library/router.py's save_video. Kept here anyway as the documented shape
    those Form params assemble into, mirrored by lib/api.ts's TicketMessage
    input type on the frontend."""

    body: str
    is_internal: bool = False


class TriageRequest(BaseModel):
    """A partial update -- only fields the client actually sent are applied
    (via .model_dump(exclude_unset=True), same convention as permissions'
    RoleUpdateRequest/service.py's update_role). `assigned_to` follows the
    same omit-vs-explicit-null distinction: omitted leaves it unchanged,
    `null` unassigns, a user id assigns."""

    state: TicketState | None = None
    priority: TicketPriority | None = None
    layer: TicketLayer | None = None
    assigned_to: str | None = None
