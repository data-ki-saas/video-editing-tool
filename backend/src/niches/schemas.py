from typing import Literal

from pydantic import BaseModel, Field


class NicheField(BaseModel):
    key: str
    label: str
    type: Literal["text", "number", "textarea"] = "text"
    required: bool = False


class NicheConfig(BaseModel):
    id: str
    niche_key: str
    display_name: str
    fields: list[NicheField]
    script_template: str | None = None
    created_at: str


class GenerateNicheRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
