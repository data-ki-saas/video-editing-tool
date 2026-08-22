import httpx

from src.core.config import settings

# https://www.pexels.com/api/documentation/ -- one key covers both photos
# and videos. The key goes in a plain Authorization header, with no
# "Bearer" prefix (unlike most APIs -- Pexels' own docs are explicit about
# this).
_BASE_URL = "https://api.pexels.com"


def _headers() -> dict[str, str]:
    return {"Authorization": settings.pexels_api_key}


async def search_photos(query: str, page: int, per_page: int = 24) -> dict:
    async with httpx.AsyncClient(base_url=_BASE_URL, timeout=15) as client:
        response = await client.get(
            "/v1/search", headers=_headers(), params={"query": query, "page": page, "per_page": per_page}
        )
    response.raise_for_status()
    return response.json()


async def search_videos(query: str, page: int, max_duration_seconds: int, per_page: int = 24) -> dict:
    async with httpx.AsyncClient(base_url=_BASE_URL, timeout=15) as client:
        response = await client.get(
            "/v1/videos/search",
            headers=_headers(),
            params={"query": query, "page": page, "per_page": per_page, "max_duration": max_duration_seconds},
        )
    response.raise_for_status()
    return response.json()


async def get_photo(photo_id: str) -> dict:
    async with httpx.AsyncClient(base_url=_BASE_URL, timeout=15) as client:
        response = await client.get(f"/v1/photos/{photo_id}", headers=_headers())
    response.raise_for_status()
    return response.json()


async def get_video(video_id: str) -> dict:
    async with httpx.AsyncClient(base_url=_BASE_URL, timeout=15) as client:
        response = await client.get(f"/v1/videos/videos/{video_id}", headers=_headers())
    response.raise_for_status()
    return response.json()
