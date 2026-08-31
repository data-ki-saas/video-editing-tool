from dataclasses import dataclass


@dataclass(frozen=True)
class Feature:
    key: str
    label: str
    group: str


# One entry per meaningful capability a role can be granted or denied --
# router-level, not one per literal endpoint (e.g. all of assets/router.py
# is "assets_manage", not a separate key per upload/list/delete). Keys are
# permanent once shipped: renaming one needs a data migration (role_features
# rows reference these strings, not an FK -- see 0015's own comment on why).
FEATURES: list[Feature] = [
    Feature("render_generate", "Cloud render", "Rendering & AI"),
    Feature("tts_synthesize", "AI voiceover", "Rendering & AI"),
    Feature("avatar_generate", "AI avatar video", "Rendering & AI"),
    Feature("matting_generate", "AI background removal", "Rendering & AI"),
    Feature("assets_manage", "Upload & manage media", "Media"),
    Feature("stock_media_use", "Stock photo/video/music library", "Media"),
    Feature("projects_manage", "Create/delete/reset projects", "Projects"),
    Feature("niches_use", "Niche catalog & config", "Projects"),
    Feature("admin_manage_roles", "Manage roles, permissions & user assignment", "Admin"),
    Feature("metering_admin_view", "Usage & cost dashboard", "Admin"),
]

FEATURE_KEYS = frozenset(f.key for f in FEATURES)
_BY_KEY = {f.key: f for f in FEATURES}


def label_for(feature_key: str) -> str:
    feature = _BY_KEY.get(feature_key)
    return feature.label if feature else feature_key
