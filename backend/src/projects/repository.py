from dataclasses import dataclass

from src.core.supabase_client import get_supabase_client

_TABLE = "projects"


@dataclass
class ProjectRecord:
    id: str
    render_id: str | None
    render_status: str | None
    render_url: str | None


def get_project(project_id: str, owner_id: str) -> ProjectRecord | None:
    result = (
        get_supabase_client()
        .table(_TABLE)
        .select("id, render_id, render_status, render_url")
        .eq("id", project_id)
        .eq("owner_id", owner_id)
        .limit(1)
        .execute()
    )
    if not result.data:
        return None
    return ProjectRecord(**result.data[0])


def delete_project(project_id: str) -> None:
    get_supabase_client().table(_TABLE).delete().eq("id", project_id).execute()


# Doesn't touch `timeline` -- that jsonb column is only ever written by the
# frontend directly via Supabase (see frontend/src/lib/projects.ts's
# saveTimeline), same as every other edit to it. This only clears the render
# tracking columns; service.reset_project's caller resets `timeline` itself
# the same way any other save would.
def clear_render_state(project_id: str) -> None:
    get_supabase_client().table(_TABLE).update(
        {"render_id": None, "render_status": None, "render_url": None, "render_error": None, "render_started_at": None}
    ).eq("id", project_id).execute()
