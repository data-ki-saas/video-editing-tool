from fastapi import HTTPException

from src.core.auth import CurrentUser
from src.scripts import repository
from src.scripts.schemas import ScriptInfo

# A hard product cap (not a paywall-gated one, unlike recordings/service.py's
# FREE_RECORDINGS_LIMIT + recordings_unlimited escape hatch) -- every account
# keeps at most this many saved scripts.
MAX_SCRIPTS_PER_USER = 5


def _to_script_info(record: repository.ScriptRecord) -> ScriptInfo:
    return ScriptInfo(
        id=record.id,
        user_id=record.user_id,
        name=record.name,
        text=record.text,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def list_scripts(user: CurrentUser) -> list[ScriptInfo]:
    return [_to_script_info(record) for record in repository.list_for_user(user.id)]


def create_script(name: str, text: str, user: CurrentUser) -> ScriptInfo:
    if repository.count_for_user(user.id) >= MAX_SCRIPTS_PER_USER:
        raise HTTPException(
            status_code=429,
            detail=f"You can keep at most {MAX_SCRIPTS_PER_USER} scripts -- delete one to add another.",
        )
    record = repository.create(user_id=user.id, name=name, text=text)
    return _to_script_info(record)


def delete_script(script_id: str, user: CurrentUser) -> None:
    record = repository.delete(script_id, user.id)
    if record is None:
        raise HTTPException(status_code=404, detail="Script not found")
