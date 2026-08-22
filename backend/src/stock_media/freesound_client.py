import httpx

from src.core.config import settings

# https://freesound.org/docs/api/ -- simple token auth is enough for search
# and for preview-quality audio (previews.preview-hq-mp3 below); the
# original-quality download resource is OAuth2-gated, which is a much
# heavier flow this app doesn't implement -- previews are good enough
# quality (~128kbps mp3) for background music behind a reel.
_BASE_URL = "https://freesound.org/apiv2"

# CC0 only -- public domain, free to use commercially with no attribution
# required. Freesound's other license tiers (CC-BY, CC-BY-NC) either need
# attribution this app has no way to carry through into a rendered video,
# or forbid commercial use outright -- neither fits background music behind
# a creator's monetized reel.
_CC0_FILTER = 'license:"Creative Commons 0"'
_FIELDS = "id,name,duration,previews,username"


async def search_music(query: str, page: int, max_duration_seconds: int, page_size: int = 24) -> dict:
    async with httpx.AsyncClient(base_url=_BASE_URL, timeout=15) as client:
        response = await client.get(
            "/search/text/",
            params={
                "query": query,
                "token": settings.freesound_api_key,
                "page": page,
                "page_size": page_size,
                "fields": _FIELDS,
                "filter": f"{_CC0_FILTER} duration:[0 TO {max_duration_seconds}]",
            },
        )
    response.raise_for_status()
    return response.json()


async def get_sound(sound_id: str) -> dict:
    async with httpx.AsyncClient(base_url=_BASE_URL, timeout=15) as client:
        response = await client.get(
            f"/sounds/{sound_id}/", params={"token": settings.freesound_api_key, "fields": _FIELDS}
        )
    response.raise_for_status()
    return response.json()
