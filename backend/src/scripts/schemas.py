from pydantic import BaseModel, Field, field_validator

# ~3 minutes of read-aloud script at CameraCapturePage.tsx's own
# TELEPROMPTER_WORDS_PER_SECOND pace (150 words/minute) -- kept in sync with
# that constant by hand (frontend/backend are two different languages, no
# shared config), not derived from it.
MAX_SCRIPT_WORDS = 450


def _validate_word_count(text: str) -> str:
    word_count = len(text.split())
    if word_count > MAX_SCRIPT_WORDS:
        raise ValueError(f"Script is too long ({word_count} words) -- scripts are limited to about 3 minutes (~{MAX_SCRIPT_WORDS} words)")
    return text


class ScriptInfo(BaseModel):
    id: str
    user_id: str
    name: str
    text: str
    created_at: str
    updated_at: str


class ScriptsResponse(BaseModel):
    scripts: list[ScriptInfo]


class CreateScriptRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=6000)

    _validate_text = field_validator("text")(_validate_word_count)
