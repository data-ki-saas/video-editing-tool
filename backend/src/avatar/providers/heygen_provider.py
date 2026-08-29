import hmac
import logging

import httpx

from src.avatar.providers.base import AvatarOption, AvatarProvider, AvatarVideoHandle, AvatarWebhookEvent

logger = logging.getLogger(__name__)

# https://developers.heygen.com/reference/create-video
_BASE_URL = "https://api.heygen.com"


class HeyGenProvider(AvatarProvider):
    def __init__(self, *, api_key: str, webhook_secret: str):
        self._api_key = api_key
        # Our OWN shared secret, appended as a `secret` query param on the
        # callback_url we hand HeyGen (see service.py's build_callback_url) --
        # NOT the per-endpoint secret HeyGen issues if you register a
        # persistent webhook endpoint via POST /v3/webhooks/endpoints. That
        # flow would let us verify HeyGen's own Heygen-Signature HMAC header,
        # but it's unconfirmed whether an inline `callback_url` (the
        # lighter-weight option this provider actually uses, see
        # create_video below) is signed the same way. Until that's verified
        # against a real delivery, this shared-secret-in-the-URL scheme is
        # the one actual security boundary here -- same reasoning, and same
        # caveat, as this app's existing Creatomate webhook (see
        # frontend/src/app/api/webhooks/creatomate/route.ts's own comment).
        self._webhook_secret = webhook_secret

    async def create_video(
        self, *, audio_url: str, avatar_id: str, aspect_ratio: str, callback_url: str
    ) -> AvatarVideoHandle:
        self._require_api_key()
        async with httpx.AsyncClient(base_url=_BASE_URL, timeout=30) as client:
            response = await client.post(
                "/v3/videos",
                headers={"x-api-key": self._api_key, "Content-Type": "application/json"},
                json={
                    "type": "avatar",
                    "avatar_id": avatar_id,
                    "audio_url": audio_url,
                    "aspect_ratio": aspect_ratio,
                    "resolution": "720p",
                    "output_format": "mp4",
                    "callback_url": callback_url,
                },
            )
        response.raise_for_status()
        video_id = response.json()["data"]["video_id"]
        return AvatarVideoHandle(provider_video_id=video_id)

    def verify_webhook(self, *, raw_body: bytes, headers: dict[str, str], query_secret: str | None) -> bool:
        if not self._webhook_secret or query_secret is None:
            return False
        return hmac.compare_digest(self._webhook_secret, query_secret)

    def parse_webhook(self, payload: dict) -> AvatarWebhookEvent:
        # NOT verified against a live delivery (no sandbox account available
        # while wiring this up) -- confirm field names against a real
        # webhook payload (HeyGen's dashboard should log recent deliveries)
        # before relying on this in production, same caveat this app's
        # Creatomate webhook parsing already carries. Parsed defensively
        # (multiple plausible shapes, never raises on an unexpected one) so
        # a drifted field name degrades to "unrecognized event" rather than
        # a 500 that HeyGen would just retry forever.
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
        video_id = data.get("video_id") or data.get("id")
        event_type = payload.get("event_type") or payload.get("event") or ""
        video_obj = data.get("video") if isinstance(data.get("video"), dict) else data
        video_url = video_obj.get("video_url") or video_obj.get("url")
        error = data.get("error") or data.get("message")

        is_failure = "fail" in str(event_type).lower() or bool(error and not video_url)
        return AvatarWebhookEvent(
            provider_video_id=str(video_id) if video_id else "",
            status="failed" if is_failure else "completed",
            video_url=video_url if isinstance(video_url, str) else None,
            error=str(error) if error else None,
        )

    def _require_api_key(self) -> None:
        # Unlike DeepSeekProvider's Authorization: Bearer header, HeyGen's
        # x-api-key header is technically legal even empty (no
        # httpx.LocalProtocolError) -- an empty key here instead surfaces
        # only as a 401 from HeyGen once raise_for_status() runs, which reads
        # identically to "wrong key" and "not configured at all" alike. This
        # check gives the actually-more-likely cause (never set on this
        # deploy yet, see DEPLOY.md's HEYGEN_* row) its own clear message,
        # same reasoning as the LLM providers' own empty-key checks.
        if not self._api_key:
            raise ValueError("HeyGen API key is not configured (HEYGEN_API_KEY is empty).")

    async def list_avatars(self) -> list[AvatarOption]:
        # /v3/avatars/looks (not /v3/avatars, which lists GROUPS -- containers
        # of looks, not directly usable as an avatar_id) -- ownership=private
        # returns the avatars actually created/uploaded under THIS account's
        # own HeyGen credentials, not HeyGen's generic preset catalog
        # (ownership=public would be that instead -- a real mixup fixed
        # here, since a creator picking "their" avatar should see the ones
        # they made, not a stock list they've never seen before). See
        # https://developers.heygen.com/reference/list-avatar-looks
        self._require_api_key()
        async with httpx.AsyncClient(base_url=_BASE_URL, timeout=30) as client:
            response = await client.get(
                "/v3/avatars/looks",
                headers={"x-api-key": self._api_key},
                params={"ownership": "private", "limit": 50},
            )
        response.raise_for_status()
        rows = response.json().get("data") or []

        options = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            avatar_id, name = row.get("id"), row.get("name")
            if not isinstance(avatar_id, str) or not isinstance(name, str):
                continue
            # Skip anything not ready to use -- see the `status` field's own
            # possible values (processing/pending_consent/failed/completed)
            # in the docs; only a completed look actually renders.
            status = row.get("status")
            if status is not None and status != "completed":
                continue
            options.append(
                AvatarOption(
                    id=avatar_id,
                    name=name,
                    preview_image_url=row.get("preview_image_url"),
                    gender=row.get("gender"),
                    preferred_orientation=row.get("preferred_orientation"),
                )
            )
        return options
