from fastapi import HTTPException

from src.core.auth import CurrentUser, bypasses_daily_caps
from src.core.config import settings
from src.metering import service as metering_service
from src.usage import repository
from src.usage.schemas import UsageSummaryItem, UsageSummaryResponse

# (event_type, label, cap) -- the same three usage_events event_types
# enforced today by api/render/route.ts (render), tts/service.py
# (voiceover), and avatar/service.py (avatar_video).
_FEATURES = [
    ("render", "Reels rendered", lambda: settings.render_daily_cap),
    ("voiceover", "Voiceovers generated", lambda: settings.tts_daily_cap),
    ("avatar_video", "Avatar videos generated", lambda: settings.avatar_daily_cap),
]


def get_summary(user: CurrentUser) -> UsageSummaryResponse:
    items = []
    for event_type, label, get_limit in _FEATURES:
        count = repository.count_recent_events(user.id, event_type)
        items.append(UsageSummaryItem(event_type=event_type, label=label, count=count or 0, limit=get_limit()))
    return UsageSummaryResponse(items=items)


def assert_render_cap(user: CurrentUser) -> None:
    """The render daily cap's actual enforcement point -- called by
    frontend/src/app/api/render/route.ts before it starts a Creatomate
    render, the same way that route already calls POST
    /api/permissions/assert for the render_generate feature check. Moved
    server-side (this used to be a direct Supabase query from the Next.js
    route) so admin bypass and cap-warning logging live in one place instead
    of being reimplemented in TypeScript -- see core/auth.py's
    bypasses_daily_caps and metering/service.py's record_cap_hit."""
    if bypasses_daily_caps(user):
        return
    recent_count = repository.count_recent_events(user.id, "render")
    if recent_count is not None and recent_count >= settings.render_daily_cap:
        metering_service.record_cap_hit(
            user_id=user.id, feature="render", cap_value=settings.render_daily_cap, count_at_trigger=recent_count + 1
        )
        raise HTTPException(
            status_code=429,
            detail=f"You've reached the limit of {settings.render_daily_cap} renders per day. Try again tomorrow.",
        )
