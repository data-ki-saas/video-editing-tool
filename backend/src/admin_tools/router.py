import logging

from botocore.exceptions import ClientError
from fastapi import APIRouter, Depends, HTTPException

from src.admin_tools import service
from src.core.auth import CurrentUser, require_feature

logger = logging.getLogger(__name__)

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
    except ClientError as exc:
        logger.exception("R2 CORS configuration failed")
        code = exc.response.get("Error", {}).get("Code", "")
        if code == "AccessDenied":
            # R2 API tokens commonly allow Object Read & Write (what every
            # other r2_client.py call needs) without also granting the
            # bucket-level "Edit" permission PutBucketCors needs -- these are
            # separate scopes in Cloudflare's R2 token UI, not a single
            # "read & write" toggle. Confirmed by reproducing this locally:
            # head_bucket (object-scope) succeeded, get_bucket_cors
            # (bucket-scope) returned this same AccessDenied.
            detail = (
                "R2 rejected this with Access Denied -- the R2 API token "
                "(R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY) has object-level "
                "access but not the bucket-level 'Edit'/CORS permission. "
                "Either widen that token's scope in the Cloudflare dashboard, "
                "or apply the CORS policy there directly (R2 > bucket > "
                "Settings > CORS Policy) instead of through this button."
            )
        else:
            detail = f"R2 rejected this ({code or 'unknown error'}) -- see backend logs for the full response."
        raise HTTPException(status_code=502, detail=detail) from exc
