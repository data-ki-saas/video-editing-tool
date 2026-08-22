"""One-time infra setup: apply a CORS policy to the private uploads bucket.

Presigned GET URLs (see src/storage/r2_client.py::presigned_get_url) point
straight at R2's own origin, bypassing the backend entirely -- so the
backend's CORS_ORIGINS/CORSMiddleware setting has no effect on them. Without
a CORS policy on the bucket itself, the frontend's client-side video editor
(canvas frame extraction, Web Audio decode) fails: <video> playback works
either way (media playback is CORS-exempt), but canvas.drawImage() +
toDataURL()/getImageData() throws "tainted canvas", and fetch() for
decodeAudioData is rejected outright.

This reuses settings.cors_origin_list (the same origins already allowed to
call the backend API) as the bucket's AllowedOrigins, since those are
exactly the origins that legitimately read presigned URLs from a browser.

Run once per environment (local + prod), after backend/.env or the
platform's env vars are set:

    uv run python scripts/configure_r2_cors.py
"""

from src.core.config import settings
from src.storage.r2_client import get_r2_client


def main() -> None:
    if not settings.cors_origin_list:
        raise SystemExit("CORS_ORIGINS is empty -- set it before running this script.")

    get_r2_client().put_bucket_cors(
        Bucket=settings.r2_bucket_name,
        CORSConfiguration={
            "CORSRules": [
                {
                    "AllowedOrigins": settings.cors_origin_list,
                    "AllowedMethods": ["GET", "HEAD"],
                    "AllowedHeaders": ["*"],
                    # Content-Range/Accept-Ranges let <video> byte-range seek;
                    # ETag lets the browser cache thumbnail/decode work per asset.
                    "ExposeHeaders": ["ETag", "Content-Length", "Content-Range", "Accept-Ranges"],
                    "MaxAgeSeconds": 3600,
                }
            ]
        },
    )
    print(f"Applied CORS policy to {settings.r2_bucket_name!r} for origins: {settings.cors_origin_list}")


if __name__ == "__main__":
    main()
