from fastapi import APIRouter, Depends

from src.core.auth import CurrentUser, get_current_user, require_feature
from src.scripts import service
from src.scripts.schemas import CreateScriptRequest, ScriptInfo, ScriptsResponse

router = APIRouter(prefix="/api/scripts", tags=["scripts"], dependencies=[Depends(require_feature("assets_manage"))])


@router.get("", response_model=ScriptsResponse)
async def list_scripts(user: CurrentUser = Depends(get_current_user)) -> ScriptsResponse:
    return ScriptsResponse(scripts=service.list_scripts(user))


@router.post("", response_model=ScriptInfo, status_code=201)
async def create_script(body: CreateScriptRequest, user: CurrentUser = Depends(get_current_user)) -> ScriptInfo:
    return service.create_script(body.name, body.text, user)


@router.delete("/{script_id}", status_code=204)
async def delete_script(script_id: str, user: CurrentUser = Depends(get_current_user)) -> None:
    service.delete_script(script_id, user)
