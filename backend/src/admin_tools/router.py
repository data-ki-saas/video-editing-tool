from fastapi import APIRouter, Depends, HTTPException

from src.admin_tools import service
from src.core.auth import CurrentUser, require_feature

router = APIRouter(prefix="/api/admin/tools", tags=["admin-tools"])

# Every endpoint below shares this one gate -- same single-alias precedent as
# permissions/router.py's own _require_manage_roles. This is a small,
# low-traffic ops surface (buttons for scripts an admin would otherwise need
# shell/DB access to run), not a fine-grained permission area, so one feature
# key covers the whole page rather than one per button.
_require_admin_tools = require_feature("admin_ops_tools")


@router.post("/rebake-avatars")
async def rebake_avatars(user: CurrentUser = Depends(_require_admin_tools)) -> dict[str, int]:
    """Re-applies the current atlas_builder.py baking code to every fal.ai
    avatar with a cached source photo -- see avatar_gen.service.rebake_all_avatars
    / scripts/rebake_avatars.py's own docstring for when this is needed."""
    return service.run_rebake_avatars()


@router.post("/configure-r2-cors")
async def configure_r2_cors(user: CurrentUser = Depends(_require_admin_tools)) -> dict[str, object]:
    """(Re-)applies the private uploads bucket's CORS policy from today's
    CORS_ORIGINS -- see storage.r2_client.configure_uploads_bucket_cors's own
    docstring for why this is needed."""
    try:
        return service.run_configure_r2_cors()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
