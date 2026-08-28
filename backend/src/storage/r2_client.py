from functools import lru_cache
from pathlib import Path

import boto3
from boto3.s3.transfer import TransferConfig

from src.core.config import settings

# R2 API tokens commonly allow PutObject but deny CreateMultipartUpload even
# under "Object Read & Write" scoping. Since uploads are already capped at
# settings.max_upload_size_bytes (well under S3/R2's 5 GiB single-PUT limit),
# raising the multipart threshold above that cap forces every upload through
# a plain PutObject and avoids the multipart permission entirely.
_UPLOAD_TRANSFER_CONFIG = TransferConfig(multipart_threshold=settings.max_upload_size_bytes + 1)


@lru_cache
def get_r2_client():
    return boto3.client(
        "s3",
        endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        region_name="auto",
    )


@lru_cache
def get_r2_renders_client():
    """Separate client/credentials from get_r2_client() above -- the renders
    bucket uses its own API token (see settings.r2_renders_access_key_id),
    same R2 account. Only used to delete a render object on project delete;
    worker/src/server.js owns writing to this bucket."""
    return boto3.client(
        "s3",
        endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_renders_access_key_id,
        aws_secret_access_key=settings.r2_renders_secret_access_key,
        region_name="auto",
    )


def upload_file(local_path: Path, key: str, content_type: str) -> None:
    get_r2_client().upload_file(
        str(local_path),
        settings.r2_bucket_name,
        key,
        ExtraArgs={"ContentType": content_type},
        Config=_UPLOAD_TRANSFER_CONFIG,
    )


def delete_object(key: str) -> None:
    get_r2_client().delete_object(Bucket=settings.r2_bucket_name, Key=key)


def delete_render_object(project_id: str, render_id: str) -> None:
    """Matches the key format worker/src/server.js's transferRenderToR2 wrote
    it under -- see that function's own `key` line. Only called once a
    render has actually landed in the renders bucket (render_url set)."""
    key = f"renders/{project_id}/{render_id}.mp4"
    get_r2_renders_client().delete_object(Bucket=settings.r2_renders_bucket_name, Key=key)


def upload_public_object(local_path: Path, key: str, content_type: str) -> str:
    """Writes straight to the PUBLIC renders bucket and returns its public
    URL -- used only by the thumbnail/cover picker (projects/service.py's
    upload_thumbnail), which needs a synchronous upload+URL, unlike every
    other write to this bucket (worker/src/server.js's async render
    mirror)."""
    get_r2_renders_client().upload_file(
        str(local_path),
        settings.r2_renders_bucket_name,
        key,
        ExtraArgs={"ContentType": content_type},
        Config=_UPLOAD_TRANSFER_CONFIG,
    )
    return f"{settings.r2_renders_public_url.rstrip('/')}/{key}"


def delete_public_object(key: str) -> None:
    get_r2_renders_client().delete_object(Bucket=settings.r2_renders_bucket_name, Key=key)


def thumbnail_key_from_url(url: str) -> str | None:
    """Recovers the R2 key from a previously-returned upload_public_object
    URL, so a replaced/cleared cover can delete its old object without a
    dedicated storage-key column -- there's only ever one live thumbnail per
    project, so this is cheaper than tracking a key for it separately."""
    prefix = f"{settings.r2_renders_public_url.rstrip('/')}/"
    if not url.startswith(prefix):
        return None
    return url[len(prefix):]


def presigned_get_url(key: str) -> str:
    """A time-limited, signed read URL for a private R2 object -- the bucket
    itself must NOT be public. Every caller re-checks Supabase ownership
    (see assets/repository.py) before this is ever generated, so a leaked
    link only grants read access for `r2_signed_url_expires_seconds`, not
    forever. Pure local HMAC signing (no network call to R2), so generating
    one per asset in a list response is cheap."""
    return get_r2_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.r2_bucket_name, "Key": key},
        ExpiresIn=settings.r2_signed_url_expires_seconds,
    )
