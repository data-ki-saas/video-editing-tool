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


def upload_file(local_path: Path, key: str, content_type: str) -> str:
    get_r2_client().upload_file(
        str(local_path), settings.r2_bucket_name, key, ExtraArgs={"ContentType": content_type}
    )
    return public_url(key)


def delete_object(key: str) -> None:
    get_r2_client().delete_object(Bucket=settings.r2_bucket_name, Key=key)


def public_url(key: str) -> str:
    return f"{settings.r2_public_url.rstrip('/')}/{key}"
