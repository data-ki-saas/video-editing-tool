from dataclasses import dataclass
from typing import Callable

from src.core.config import settings


@dataclass(frozen=True)
class ResourceItem:
    key: str
    label: str
    # What one priced unit is, as shown next to the price ("second", "image",
    # "1,000 tokens").
    unit_label: str
    # Ledger quantity per priced unit (usage_ledger.quantity is in raw
    # seconds/images/tokens; tokens are priced per 1,000).
    per: float
    # Our own estimated provider cost for one priced unit, in cents -- shown
    # to the admin beside the price they are setting. None = not meaningful.
    provider_cost_cents: Callable[[], float | None]


RESOURCES: list[ResourceItem] = [
    ResourceItem("voiceover_seconds", "AI voiceover", "second of audio", 1, lambda: settings.tts_cost_cents_per_second),
    ResourceItem(
        "background_removal_video_seconds",
        "Background removal (video)",
        "second of video",
        1,
        lambda: settings.veed_cost_cents_per_second,
    ),
    ResourceItem(
        "background_removal_image", "Background removal (photo)", "photo", 1, lambda: settings.rembg_cost_cents_per_image
    ),
    ResourceItem(
        "avatar_generate_image", "Avatar from photo", "avatar", 1, lambda: settings.cartoonify_cost_cents_per_image
    ),
    ResourceItem(
        "avatar_generate_local_image",
        "Basic avatar (drawn, no AI service)",
        "avatar",
        1,
        lambda: 0.0,
    ),
    ResourceItem("upload_mb", "File upload", "MB uploaded", 1, lambda: 0.0),
    ResourceItem("stock_import_item", "Stock media import", "item imported", 1, lambda: 0.0),
    ResourceItem("recording_upload_mb", "Recording saved", "MB saved", 1, lambda: 0.0),
    ResourceItem("library_save_mb", "Reel saved to library", "MB saved", 1, lambda: 0.0),
    ResourceItem("llm_tokens", "AI script & avatar direction", "1,000 tokens", 1000, lambda: None),
]

_BY_KEY = {item.key: item for item in RESOURCES}


def compute_charge_cents(quantity: float, per: float, unit_price_cents: float) -> float:
    return quantity / per * unit_price_cents


def get_item(key: str) -> ResourceItem | None:
    return _BY_KEY.get(key)


def resolve_key(event_type: str, provider: str, unit: str) -> str | None:
    """Maps a usage_ledger row's (event_type, provider, unit) to the priced
    consumption item it belongs to. Every consumption we record has an item --
    including ones that cost us nothing (local avatar, uploads), since an
    admin may still want to charge for them -- so None only means an event
    type nothing records any more."""
    if event_type == "voiceover" and unit == "seconds":
        return "voiceover_seconds"
    if event_type == "background_removal":
        if unit == "images":
            return "background_removal_image"
        if unit == "seconds":
            return "background_removal_video_seconds"
    if event_type == "avatar_generate" and unit == "images":
        return "avatar_generate_image" if provider == "fal_ai" else "avatar_generate_local_image"
    if event_type == "upload" and unit == "megabytes":
        return "upload_mb"
    if event_type == "stock_import" and unit == "items":
        return "stock_import_item"
    if event_type == "recording_upload" and unit == "megabytes":
        return "recording_upload_mb"
    if event_type == "library_save" and unit == "megabytes":
        return "library_save_mb"
    if event_type == "llm_completion" and unit == "tokens":
        return "llm_tokens"
    return None
