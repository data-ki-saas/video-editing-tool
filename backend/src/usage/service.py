from src.core.auth import CurrentUser
from src.core.config import settings
from src.usage import repository
from src.usage.schemas import UsageSummaryItem, UsageSummaryResponse

# (event_type, label, cap) -- the same usage_events event_types enforced
# today by tts/service.py (voiceover).
_FEATURES = [
    ("voiceover", "Voiceovers generated", lambda: settings.tts_daily_cap),
]


def get_summary(user: CurrentUser) -> UsageSummaryResponse:
    items = []
    for event_type, label, get_limit in _FEATURES:
        count = repository.count_recent_events(user.id, event_type)
        items.append(UsageSummaryItem(event_type=event_type, label=label, count=count or 0, limit=get_limit()))
    return UsageSummaryResponse(items=items)
