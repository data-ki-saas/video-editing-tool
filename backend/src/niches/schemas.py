from typing import Literal

from pydantic import BaseModel, Field


class NicheField(BaseModel):
    key: str
    label: str
    type: Literal["text", "number", "textarea"] = "text"
    required: bool = False


class MediaSlot(BaseModel):
    key: str
    label: str
    hint: str
    kind: Literal["image", "video", "either"] = "either"
    required: bool = False


class NicheConfig(BaseModel):
    id: str
    niche_key: str
    display_name: str
    fields: list[NicheField]
    script_template: str | None = None
    media_slots: list[MediaSlot] = []
    hooks: list[str] = []
    cta_template: str | None = None
    hashtag_seed: list[str] = []
    created_at: str


class GenerateNicheRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
