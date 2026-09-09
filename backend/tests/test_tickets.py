from src.core.auth import CurrentUser, get_current_user
from src.core.config import settings
from src.main import app
from src.permissions.features import FEATURE_KEYS

FILER = CurrentUser(id="filer-id", email="filer@example.com", role="free_user", role_label="Free", features=frozenset())
OTHER_FILER = CurrentUser(id="other-filer-id", email="other-filer@example.com", role="free_user", role_label="Free", features=frozenset())
ADMIN = CurrentUser(id="admin-id", email="admin@example.com", role="admin", role_label="Admin", features=frozenset(FEATURE_KEYS))


def _as(user: CurrentUser) -> None:
    app.dependency_overrides[get_current_user] = lambda: user


# --- Filing a ticket ---------------------------------------------------------


async def test_create_ticket_starts_new_with_one_message(client, fake_tickets_table):
    _as(FILER)
    response = await client.post("/api/tickets", data={"subject": "Export is broken", "body": "The MP4 won't play", "priority": "high"})
    assert response.status_code == 201
    ticket = response.json()
    assert ticket["state"] == "new"
    assert ticket["priority"] == "high"
    assert ticket["layer"] is None
    assert ticket["assigned_to"] is None
    assert ticket["message_count"] == 1
    assert ticket["messages"][0]["body"] == "The MP4 won't play"
    assert ticket["messages"][0]["is_admin_reply"] is False


async def test_create_ticket_rejects_empty_subject(client, fake_tickets_table):
    _as(FILER)
    response = await client.post("/api/tickets", data={"subject": "  ", "body": "details"})
    assert response.status_code == 400


async def test_create_ticket_rejects_empty_body(client, fake_tickets_table):
    _as(FILER)
    response = await client.post("/api/tickets", data={"subject": "Subject", "body": "   "})
    assert response.status_code == 400


async def test_create_ticket_with_attachment(client, fake_tickets_table):
    _as(FILER)
    files = [("files", ("screenshot.png", b"fake png bytes", "image/png"))]
    response = await client.post("/api/tickets", data={"subject": "Broken render", "body": "See attached"}, files=files)
    assert response.status_code == 201
    attachments = response.json()["messages"][0]["attachments"]
    assert len(attachments) == 1
    assert attachments[0]["filename"] == "screenshot.png"
    assert attachments[0]["url"]


async def test_create_ticket_rejects_more_than_five_attachments(client, fake_tickets_table):
    _as(FILER)
    files = [("files", (f"f{i}.png", b"data", "image/png")) for i in range(6)]
    response = await client.post("/api/tickets", data={"subject": "Subject", "body": "body"}, files=files)
    assert response.status_code == 400


async def test_create_ticket_rejects_oversized_attachment(client, fake_tickets_table):
    _as(FILER)
    oversized = b"x" * (2 * 1024 * 1024 + 1)
    files = [("files", ("big.png", oversized, "image/png"))]
    response = await client.post("/api/tickets", data={"subject": "Subject", "body": "body"}, files=files)
    assert response.status_code == 413


async def test_create_ticket_rejects_unsupported_attachment_type(client, fake_tickets_table):
    _as(FILER)
    files = [("files", ("clip.mp4", b"data", "video/mp4"))]
    response = await client.post("/api/tickets", data={"subject": "Subject", "body": "body"}, files=files)
    assert response.status_code == 400


async def test_filing_is_capped_per_day_but_admins_bypass_it(client, fake_tickets_table):
    fake_tickets_table.recent_ticket_events[FILER.id] = settings.tickets_daily_cap
    _as(FILER)
    capped = await client.post("/api/tickets", data={"subject": "One more", "body": "body"})
    assert capped.status_code == 429

    fake_tickets_table.recent_ticket_events[ADMIN.id] = settings.tickets_daily_cap
    _as(ADMIN)
    admin_response = await client.post("/api/tickets", data={"subject": "Admin ticket", "body": "body"})
    assert admin_response.status_code == 201


# --- Ownership / visibility ---------------------------------------------------


async def test_non_owner_non_admin_cannot_view_ticket(client, fake_tickets_table):
    _as(FILER)
    created = (await client.post("/api/tickets", data={"subject": "Subject", "body": "body"})).json()

    _as(OTHER_FILER)
    response = await client.get(f"/api/tickets/{created['id']}")
    assert response.status_code == 404


async def test_admin_viewing_a_new_ticket_marks_it_seen(client, fake_tickets_table):
    _as(FILER)
    created = (await client.post("/api/tickets", data={"subject": "Subject", "body": "body"})).json()
    assert created["state"] == "new"

    _as(ADMIN)
    response = await client.get(f"/api/tickets/{created['id']}")
    assert response.status_code == 200
    assert response.json()["state"] == "seen"

    # Owner still sees it as seen too -- state tracks admin attention, not
    # who's asking.
    _as(FILER)
    assert (await client.get(f"/api/tickets/{created['id']}")).json()["state"] == "seen"


async def test_non_admin_cannot_list_admin_queue(client, fake_tickets_table):
    _as(FILER)
    response = await client.get("/api/tickets/admin")
    assert response.status_code == 403


# --- Internal notes vs. customer-visible comments ----------------------------


async def test_owner_cannot_post_internal_note(client, fake_tickets_table):
    _as(FILER)
    created = (await client.post("/api/tickets", data={"subject": "Subject", "body": "body"})).json()

    reply = await client.post(f"/api/tickets/{created['id']}/messages", data={"body": "trying to sneak a note", "is_internal": "true"})
    assert reply.status_code == 200
    last_message = reply.json()["messages"][-1]
    assert last_message["is_internal"] is False
    assert last_message["is_admin_reply"] is False


async def test_internal_note_is_hidden_from_the_owner_but_visible_to_admin(client, fake_tickets_table):
    _as(FILER)
    created = (await client.post("/api/tickets", data={"subject": "Subject", "body": "body"})).json()

    _as(ADMIN)
    await client.post(f"/api/tickets/{created['id']}/messages", data={"body": "checking with engineering", "is_internal": "true"})
    await client.post(f"/api/tickets/{created['id']}/messages", data={"body": "we're on it", "is_internal": "false"})

    admin_view = await client.get(f"/api/tickets/{created['id']}")
    admin_bodies = [m["body"] for m in admin_view.json()["messages"]]
    assert "checking with engineering" in admin_bodies
    assert "we're on it" in admin_bodies

    _as(FILER)
    owner_view = await client.get(f"/api/tickets/{created['id']}")
    owner_bodies = [m["body"] for m in owner_view.json()["messages"]]
    assert "checking with engineering" not in owner_bodies
    assert "we're on it" in owner_bodies


# --- Empty-message / reopen-on-reply behavior --------------------------------


async def test_message_requires_body_or_attachment(client, fake_tickets_table):
    _as(FILER)
    created = (await client.post("/api/tickets", data={"subject": "Subject", "body": "body"})).json()
    reply = await client.post(f"/api/tickets/{created['id']}/messages", data={"body": "   "})
    assert reply.status_code == 400


async def test_owner_reply_reopens_a_resolved_ticket(client, fake_tickets_table):
    _as(FILER)
    created = (await client.post("/api/tickets", data={"subject": "Subject", "body": "body"})).json()

    _as(ADMIN)
    resolved = await client.patch(f"/api/tickets/{created['id']}/triage", json={"state": "resolved"})
    assert resolved.json()["state"] == "resolved"

    _as(FILER)
    reopened = await client.post(f"/api/tickets/{created['id']}/messages", data={"body": "still broken"})
    assert reopened.json()["state"] == "new"


# --- Triage: state / priority / layer / assignee -----------------------------


async def test_triage_updates_only_the_fields_sent(client, fake_tickets_table):
    _as(FILER)
    created = (await client.post("/api/tickets", data={"subject": "Subject", "body": "body", "priority": "low"})).json()

    _as(ADMIN)
    response = await client.patch(f"/api/tickets/{created['id']}/triage", json={"layer": "backend"})
    body = response.json()
    assert body["layer"] == "backend"
    assert body["priority"] == "low"  # untouched
    assert body["state"] == "new"  # untouched


async def test_assigning_an_admin_bundles_state_to_assigned(client, fake_tickets_table):
    fake_tickets_table.add_user(ADMIN.id, email=ADMIN.email, assignable=True)
    _as(FILER)
    created = (await client.post("/api/tickets", data={"subject": "Subject", "body": "body"})).json()

    _as(ADMIN)
    response = await client.patch(f"/api/tickets/{created['id']}/triage", json={"assigned_to": ADMIN.id})
    body = response.json()
    assert body["assigned_to"] == ADMIN.id
    assert body["state"] == "assigned"
    assert body["assignee_email"] == ADMIN.email


async def test_explicit_state_is_not_overridden_by_assignment(client, fake_tickets_table):
    fake_tickets_table.add_user(ADMIN.id, email=ADMIN.email, assignable=True)
    _as(FILER)
    created = (await client.post("/api/tickets", data={"subject": "Subject", "body": "body"})).json()

    _as(ADMIN)
    response = await client.patch(
        f"/api/tickets/{created['id']}/triage", json={"assigned_to": ADMIN.id, "state": "resolved"}
    )
    assert response.json()["state"] == "resolved"


async def test_unassign_clears_assignee(client, fake_tickets_table):
    fake_tickets_table.add_user(ADMIN.id, email=ADMIN.email, assignable=True)
    _as(FILER)
    created = (await client.post("/api/tickets", data={"subject": "Subject", "body": "body"})).json()

    _as(ADMIN)
    await client.patch(f"/api/tickets/{created['id']}/triage", json={"assigned_to": ADMIN.id})
    response = await client.patch(f"/api/tickets/{created['id']}/triage", json={"assigned_to": None})
    assert response.json()["assigned_to"] is None


async def test_non_admin_cannot_triage(client, fake_tickets_table):
    _as(FILER)
    created = (await client.post("/api/tickets", data={"subject": "Subject", "body": "body"})).json()
    response = await client.patch(f"/api/tickets/{created['id']}/triage", json={"state": "resolved"})
    assert response.status_code == 403


# --- Unread indicator / admin new-count --------------------------------------


async def test_unread_count_reflects_admin_replies_and_clears_on_view(client, fake_tickets_table):
    _as(FILER)
    created = (await client.post("/api/tickets", data={"subject": "Subject", "body": "body"})).json()
    assert (await client.get("/api/tickets/unread-count")).json()["count"] == 0

    _as(ADMIN)
    await client.post(f"/api/tickets/{created['id']}/messages", data={"body": "we're looking into it"})

    _as(FILER)
    assert (await client.get("/api/tickets/unread-count")).json()["count"] == 1
    await client.get(f"/api/tickets/{created['id']}")  # marks it viewed
    assert (await client.get("/api/tickets/unread-count")).json()["count"] == 0


async def test_admin_new_count_tracks_tickets_still_in_new(client, fake_tickets_table):
    _as(FILER)
    await client.post("/api/tickets", data={"subject": "First", "body": "body"})
    second = (await client.post("/api/tickets", data={"subject": "Second", "body": "body"})).json()

    _as(ADMIN)
    assert (await client.get("/api/tickets/admin/new-count")).json()["count"] == 2
    await client.get(f"/api/tickets/{second['id']}")  # flips this one to 'seen'
    assert (await client.get("/api/tickets/admin/new-count")).json()["count"] == 1


async def test_admin_assignees_lists_only_users_whose_role_grants_the_feature(client, fake_tickets_table):
    fake_tickets_table.add_user(ADMIN.id, email=ADMIN.email, display_name="Admin", assignable=True)
    fake_tickets_table.add_user(FILER.id, email=FILER.email, display_name="Filer", assignable=False)

    _as(ADMIN)
    response = await client.get("/api/tickets/admin/assignees")
    ids = [a["id"] for a in response.json()["admins"]]
    assert ids == [ADMIN.id]
