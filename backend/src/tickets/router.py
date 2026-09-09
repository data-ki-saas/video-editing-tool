from fastapi import APIRouter, Depends, File, Form, Query, UploadFile

from src.core.auth import CurrentUser, get_current_user, require_feature
from src.tickets import service
from src.tickets.schemas import (
    AssignableAdminsResponse,
    TicketCountResponse,
    TicketDetail,
    TicketsListResponse,
    TriageRequest,
)

router = APIRouter(prefix="/api/tickets", tags=["tickets"])

# Shared by every admin-only route below -- same single-gate precedent as
# permissions/router.py's own _require_manage_roles.
_require_manage_tickets = require_feature("tickets_manage_all")


@router.post("", response_model=TicketDetail, status_code=201)
async def create_ticket(
    subject: str = Form(...),
    body: str = Form(...),
    priority: str = Form("low"),
    context_project_id: str | None = Form(None),
    context_user_agent: str | None = Form(None),
    files: list[UploadFile] = File(default=[]),
    user: CurrentUser = Depends(get_current_user),
) -> TicketDetail:
    return await service.create_ticket(
        user=user,
        subject=subject,
        body=body,
        priority=priority,
        files=files,
        context_project_id=context_project_id,
        context_user_agent=context_user_agent,
    )


@router.get("", response_model=TicketsListResponse)
async def list_my_tickets(user: CurrentUser = Depends(get_current_user)) -> TicketsListResponse:
    return TicketsListResponse(tickets=service.list_my_tickets(user))


@router.get("/unread-count", response_model=TicketCountResponse)
async def get_unread_count(user: CurrentUser = Depends(get_current_user)) -> TicketCountResponse:
    return TicketCountResponse(count=service.get_unread_count(user))


# --- Admin routes -- all declared ABOVE /{ticket_id} below so "admin" and
# "unread-count" are never captured as a ticket_id path param. ---------------


@router.get("/admin", response_model=TicketsListResponse)
async def list_all_tickets(
    state: str | None = Query(default=None),
    priority: str | None = Query(default=None),
    layer: str | None = Query(default=None),
    assigned_to: str | None = Query(default=None),
    user: CurrentUser = Depends(_require_manage_tickets),
) -> TicketsListResponse:
    return TicketsListResponse(
        tickets=service.list_all_tickets_admin(state=state, priority=priority, layer=layer, assigned_to=assigned_to)
    )


@router.get("/admin/new-count", response_model=TicketCountResponse)
async def get_new_count(user: CurrentUser = Depends(_require_manage_tickets)) -> TicketCountResponse:
    return TicketCountResponse(count=service.get_new_count())


@router.get("/admin/assignees", response_model=AssignableAdminsResponse)
async def list_assignees(user: CurrentUser = Depends(_require_manage_tickets)) -> AssignableAdminsResponse:
    return AssignableAdminsResponse(admins=service.list_assignees())


# --- Per-ticket routes -------------------------------------------------------


@router.get("/{ticket_id}", response_model=TicketDetail)
async def get_ticket(ticket_id: str, user: CurrentUser = Depends(get_current_user)) -> TicketDetail:
    return service.get_ticket_detail(ticket_id, user)


@router.post("/{ticket_id}/messages", response_model=TicketDetail)
async def add_message(
    ticket_id: str,
    body: str = Form(...),
    is_internal: bool = Form(False),
    files: list[UploadFile] = File(default=[]),
    user: CurrentUser = Depends(get_current_user),
) -> TicketDetail:
    """`is_internal` is only ever actually honored server-side for an admin
    caller replying to someone else's ticket -- see service.add_message,
    which forces it False for anyone else. Never trust this flag alone."""
    return await service.add_message(ticket_id=ticket_id, user=user, body=body, files=files, is_internal=is_internal)


@router.patch("/{ticket_id}/triage", response_model=TicketDetail)
async def update_triage(
    ticket_id: str, body: TriageRequest, user: CurrentUser = Depends(_require_manage_tickets)
) -> TicketDetail:
    return service.set_triage(ticket_id, body)
