from fastapi import APIRouter

# Intentionally empty: the HeyGen-backed talking-avatar-video endpoints this
# router used to expose (generate/get_generation/webhook) have been
# retired -- see the project's Avatar Design plan. Phase 4 (script ->
# action-timeline LLM glue) adds this router's new endpoints. Still
# registered in main.py so that addition needs no wiring change.
router = APIRouter(prefix="/api/avatar", tags=["avatar"])
