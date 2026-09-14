"""fal.ai `image-editing/cartoonify` client -- turns a real uploaded photo
into a 2D cartoon-style illustration before avatar_gen/service.py crops the
head/mouth out of it. Same calling convention as matting/providers/
fal_veed_provider.py's own create_image_cutout (plain synchronous
https://fal.run/<endpoint>, not the queue+webhook API): cartoonify is a
single image-to-image call, no job-status polling needed. A separate,
smaller module rather than folding into the matting provider -- cartoonify
and background-removal are unrelated fal-hosted models with nothing in
common beyond both being called via fal.run.
"""

from __future__ import annotations

import logging

import httpx

from src.core.config import settings

logger = logging.getLogger(__name__)

# https://fal.ai/models/fal-ai/image-editing/cartoonify/api
_CARTOONIFY_URL = "https://fal.run/fal-ai/image-editing/cartoonify"


async def cartoonify_image(*, image_url: str) -> str:
    """Returns the cartoonified image's own URL (fal-hosted, time-limited --
    the caller must download it promptly, never persist this URL itself).
    Raises on any failure; avatar_gen/service.py's caller decides how to
    degrade (falling back to the parametric-drawing path), this function
    doesn't guess at that policy."""
    if not settings.fal_api_key:
        raise ValueError("fal.ai API key is not configured (FAL_API_KEY is empty).")
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(
            _CARTOONIFY_URL,
            headers={"Authorization": f"Key {settings.fal_api_key}", "Content-Type": "application/json"},
            json={"image_url": image_url},
        )
    if response.is_error:
        logger.error(
            "fal.ai cartoonify request failed: %s %s -- %s", response.status_code, response.reason_phrase, response.text[:2000]
        )
    response.raise_for_status()
    images = response.json().get("images")
    output_url = images[0].get("url") if isinstance(images, list) and images and isinstance(images[0], dict) else None
    if not isinstance(output_url, str) or not output_url:
        raise ValueError(f"fal cartoonify response had no images[0].url: {response.json()!r}")
    return output_url
