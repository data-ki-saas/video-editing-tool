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

Same logic as the admin "Reapply R2 CORS policy" button on /admin/tools
(backend/src/admin_tools/service.py calls
src.storage.r2_client.configure_uploads_bucket_cors directly) -- kept as a
standalone script too for first-time setup, before a backend deploy exists
to click that button on.
"""

from src.storage.r2_client import configure_uploads_bucket_cors


def main() -> None:
    result = configure_uploads_bucket_cors()
    print(f"Applied CORS policy to {result['bucket']!r} for origins: {result['origins']}")


if __name__ == "__main__":
    main()
