from typing import Literal

from pydantic import BaseModel

SocialPostStatus = Literal["processing", "completed", "failed"]


class SocialAccountResponse(BaseModel):
    provider: str
    account_name: str
    connected_at: str


class SocialAccountsResponse(BaseModel):
    accounts: list[SocialAccountResponse]


class ConnectUrlResponse(BaseModel):
    url: str


class PublishRequest(BaseModel):
    library_video_id: str
    title: str
    description: str = ""


class PublishResponse(BaseModel):
    id: str
    status: SocialPostStatus


class SocialPostDetail(BaseModel):
    id: str
    status: SocialPostStatus
    provider_url: str | None = None
    error: str | None = None
