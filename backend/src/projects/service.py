import logging

from fastapi import HTTPException

from src.assets import repository as assets_repository
from src.assets import service as assets_service
from src.core.auth import CurrentUser
from src.projects import repository
from src.storage import r2_client

logger = logging.getLogger(__name__)


def _delete_assets_and_render(project_id: str, project: repository.ProjectRecord, user: CurrentUser) -> None:
    """Shared by delete_project and reset_project below: removes every
    asset's object (and, separately, any finished render) from R2. Assets go
    through assets_service.delete_asset() one by one instead of a bulk
    delete so its content-hash dedup reference counting (a shared upload
    can't be deleted out from under another project still using it) is
    respected exactly as it is for a manual single-asset delete."""
    for asset in assets_repository.list_assets_for_project(project_id, user.id):
        assets_service.delete_asset(asset.id, user)

    # render_url is only ever set once transferRenderToR2 (worker/src/
    # server.js) has actually finished writing the object -- absent means
    # either no render was ever started, or one is still in flight/failed
    # and never reached the renders bucket.
    if project.render_id and project.render_url:
        try:
            r2_client.delete_render_object(project_id, project.render_id)
        except Exception:
            logger.exception(
                "failed to delete R2 render object for project %s render %s", project_id, project.render_id
            )


def delete_project(project_id: str, user: CurrentUser) -> None:
    """Deletes a reel and every resource it owns, not just the DB row --
    the `assets` table FK is `on delete cascade`, but that alone would
    leave every asset's object (and, separately, any finished render)
    orphaned in R2 forever, since Postgres cascades don't reach outside
    the database."""
    project = repository.get_project(project_id, user.id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    _delete_assets_and_render(project_id, project, user)
    repository.delete_project(project_id)


def reset_project(project_id: str, user: CurrentUser) -> None:
    """Wipes a reel's assets and render state but keeps the row -- the
    "Reset" action beside "Delete" in ProjectList, for clearing a reel back
    to empty without losing the reel itself. Same R2 cleanup as
    delete_project above; the other half of the reset (blanking `timeline`,
    which this never touches -- see repository.clear_render_state's own
    comment) happens back in the frontend via the normal saveTimeline path
    once this call succeeds."""
    project = repository.get_project(project_id, user.id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    _delete_assets_and_render(project_id, project, user)
    repository.clear_render_state(project_id)
