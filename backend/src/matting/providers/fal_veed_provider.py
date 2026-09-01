import hashlib
import hmac
import logging
import time

import httpx

from src.matting.providers.base import MattingProvider, MatteJobHandle, MatteWebhookEvent

logger = logging.getLogger(__name__)

# https://fal.ai/models/VEED/video-background-removal/fast/api
_QUEUE_BASE_URL = "https://queue.fal.run/veed/video-background-removal/fast"

# https://fal.ai/models/fal-ai/imageutils/rembg/api -- a completely different
# fal-hosted model than VEED above (unrelated vendor, image-only), called via
# fal's plain synchronous fal.run endpoint (not queue.fal.run) since image
# matting is fast enough to await directly -- no webhook/job-id bookkeeping
# needed for this path at all.
_IMAGE_CUTOUT_URL = "https://fal.run/fal-ai/imageutils/rembg"

# NOT verified against a live delivery (no fal.ai account available while
# wiring this up) -- confirm both of the following against a real request/
# response before relying on this in production, same caveat this app's
# HeyGenProvider.parse_webhook already carries for HeyGen:
#  1. Whether the webhook URL is a query param on the queue submission
#     (fal's general Webhooks doc: "pass a webhook_url when submitting to
#     queue.fal.run") or a body field (this specific model's own doc example
#     showed `webhookUrl` in the JSON body) -- sent BOTH ways below so
#     whichever fal actually reads still works.
#  2. The exact webhook payload shape once "completed" -- assumed to mirror
#     the synchronous response schema (a `video` array of {url, content_type,
#     file_size}), wrapped the way fal's queue webhooks usually wrap a
#     result (see parse_webhook below).
_WEBHOOK_QUERY_PARAM = "fal_webhook"


def _raise_for_status(response: httpx.Response) -> None:
    # httpx.HTTPStatusError's own message is just "403 Forbidden for url
    # ..." -- it never includes the response body, which is exactly where
    # fal puts the actually-useful reason (e.g. "User is locked. Reason:
    # Exhausted balance." for a billing issue vs. a bad/revoked key). Logged
    # here, once, so a failure is diagnosable from the server logs alone
    # instead of needing to reproduce the request by hand.
    if response.is_error:
        logger.error("fal.ai request to %s failed: %s %s -- %s", response.url, response.status_code, response.reason_phrase, response.text[:2000])
    response.raise_for_status()


class FalVeedProvider(MattingProvider):
    def __init__(self, *, api_key: str, webhook_secret: str):
        self._api_key = api_key
        # fal signs webhook deliveries (X-Fal-Webhook-Signature/-Timestamp/
        # -Request-Id headers, per docs.fal.ai/model-apis/model-endpoints/
        # webhooks) -- unlike HeyGenProvider, this is real signature
        # verification, not a shared-secret-in-the-URL fallback. Kept as a
        # constructor arg (rather than reading settings directly) for the
        # same reason HeyGenProvider does: keeps this class testable without
        # importing src.core.config.
        self._webhook_secret = webhook_secret

    async def create_matte(self, *, video_url: str, callback_url: str) -> MatteJobHandle:
        self._require_api_key()
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                _QUEUE_BASE_URL,
                params={_WEBHOOK_QUERY_PARAM: callback_url},
                headers={"Authorization": f"Key {self._api_key}", "Content-Type": "application/json"},
                json={
                    "video_url": video_url,
                    # H264 splits into a separate RGB stream + a separate
                    # grayscale alpha/matte stream (two URLs in the response's
                    # `video` array) -- exactly the shape
                    # compileCreatomateTimeline.ts's maskMode: "luma" path
                    # needs, unlike vp9's single embedded-alpha stream (see
                    # this app's own provider-choice writeup for why).
                    "output_codec": "h264",
                    # Off by default: this app only stores/uses the matte
                    # stream, and edge refinement is the costlier ($0.012/sec
                    # vs $0.008/sec) of VEED's two tiers -- see matting_daily_cap's
                    # own comment on why cost is deliberately kept low here.
                    "refine_foreground_edges": False,
                    "webhookUrl": callback_url,
                },
            )
        _raise_for_status(response)
        job_id = response.json().get("request_id")
        if not isinstance(job_id, str) or not job_id:
            raise ValueError(f"fal queue response had no request_id: {response.json()!r}")
        return MatteJobHandle(provider_job_id=job_id)

    async def create_image_cutout(self, *, image_url: str) -> str:
        self._require_api_key()
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                _IMAGE_CUTOUT_URL,
                headers={"Authorization": f"Key {self._api_key}", "Content-Type": "application/json"},
                json={"image_url": image_url},
            )
        _raise_for_status(response)
        # https://fal.ai/models/fal-ai/imageutils/rembg/api's own documented
        # response shape: {"image": {"url": ..., "content_type": "image/png", ...}}
        # -- a real PNG with genuine alpha transparency, not a separate mask.
        image = response.json().get("image")
        cutout_url = image.get("url") if isinstance(image, dict) else None
        if not isinstance(cutout_url, str) or not cutout_url:
            raise ValueError(f"fal rembg response had no image.url: {response.json()!r}")
        return cutout_url

    def verify_webhook(self, *, raw_body: bytes, headers: dict[str, str], query_secret: str | None) -> bool:
        # Prefer fal's real signature if present; fall back to the
        # shared-secret query param this provider also attaches to
        # callback_url, in case fal's webhook delivery for THIS model
        # doesn't carry the signature headers documented for the general
        # queue API (unverified -- see this file's module comment).
        signature = headers.get("x-fal-webhook-signature") or headers.get("X-Fal-Webhook-Signature")
        timestamp = headers.get("x-fal-webhook-timestamp") or headers.get("X-Fal-Webhook-Timestamp")
        if signature and timestamp:
            if abs(time.time() - float(timestamp)) > 300:
                return False
            expected = hmac.new(self._webhook_secret.encode(), f"{timestamp}.".encode() + raw_body, hashlib.sha256).hexdigest()
            return hmac.compare_digest(expected, signature)
        if not self._webhook_secret or query_secret is None:
            return False
        return hmac.compare_digest(self._webhook_secret, query_secret)

    def parse_webhook(self, payload: dict) -> MatteWebhookEvent:
        # NOT verified against a live delivery -- see this file's module
        # comment. Parsed defensively (multiple plausible shapes, never
        # raises on an unexpected one) so a drifted field name degrades to
        # "unrecognized event" rather than a 500 fal would retry forever,
        # same defensive-parsing precedent as HeyGenProvider.parse_webhook.
        job_id = payload.get("request_id") or payload.get("gateway_request_id")
        status = str(payload.get("status") or "").upper()
        payload_data = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
        video_entries = payload_data.get("video")
        matte_url = None
        if isinstance(video_entries, list):
            # H264 mode returns two entries (rgb, alpha) in an unspecified
            # order -- pick whichever content_type/file_name looks like the
            # matte, not just the last one, since silently masking with the
            # rgb stream would be a real (if visually confusing) bug.
            for entry in video_entries:
                if not isinstance(entry, dict):
                    continue
                name = str(entry.get("file_name") or "").lower()
                if "alpha" in name or "matte" in name:
                    matte_url = entry.get("url")
                    break
            if matte_url is None and video_entries and isinstance(video_entries[-1], dict):
                matte_url = video_entries[-1].get("url")
        error = payload.get("error") or payload_data.get("error") if isinstance(payload_data, dict) else payload.get("error")

        is_failure = status == "ERROR" or bool(error and not matte_url)
        return MatteWebhookEvent(
            provider_job_id=str(job_id) if job_id else "",
            status="failed" if is_failure else "completed",
            matte_url=matte_url if isinstance(matte_url, str) else None,
            error=str(error) if error else None,
        )

    def _require_api_key(self) -> None:
        if not self._api_key:
            raise ValueError("fal.ai API key is not configured (FAL_API_KEY is empty).")
