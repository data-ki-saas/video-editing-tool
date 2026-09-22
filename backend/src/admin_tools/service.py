"""Thin orchestration layer behind /admin/tools -- each function here just
calls straight into the domain module that actually owns the operation
(avatar_gen, storage/r2), so this module owns no business logic of its own.
Exists so the frontend's admin tools page has one router to call instead of
reaching into avatar_gen/storage routers that are otherwise scoped to
per-user or infra concerns, not admin-triggered one-off ops."""

from src.avatar_gen.service import rebake_all_avatars
from src.storage.r2_client import configure_uploads_bucket_cors


def run_rebake_avatars() -> dict[str, int]:
    return rebake_all_avatars()


def run_configure_r2_cors() -> dict[str, object]:
    return configure_uploads_bucket_cors()
