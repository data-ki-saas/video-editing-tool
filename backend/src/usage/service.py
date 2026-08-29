from src.core.auth import CurrentUser
from src.core.config import settings
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
