from functools import lru_cache
from pathlib import Path

import boto3

from src.core.config import settings


@lru_cache
def get_r2_client():
    return boto3.client(
        "s3",
        endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        region_name="auto",
    )


def upload_file(local_path: Path, key: str, content_type: str) -> None:
    get_r2_client().upload_file(
        str(local_path), settings.r2_bucket_name, key, ExtraArgs={"ContentType": content_type}
    )


def delete_object(key: str) -> None:
    get_r2_client().delete_object(Bucket=settings.r2_bucket_name, Key=key)


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
