"""Re-applies the current avatar atlas-baking code (build_atlas_png_from_photo)
to every fal.ai-photo-generated avatar that has a cached source cartoon image,
in place -- same design_id/atlas_key, no fal.ai spend, no asking each user to
re-upload their photo and generate a brand-new avatar.

Run this once after fixing a baking bug in src/avatar_gen/atlas_builder.py
(transparency, neck backing, mouth position, eyebrows/blink, etc.) to roll
the fix out to every existing avatar it affects:

    uv run python scripts/rebake_avatars.py

Avatars with no source_cartoon_key (generated via the free parametric-drawing
path, or before this caching existed) are skipped -- they were never
rebakeable and still need the old "generate a new one" path, unchanged.

Same loop as the admin "Rebake all avatars" button on /admin/tools
(backend/src/admin_tools/service.py calls avatar_gen.service.rebake_all_avatars
directly) -- kept as a standalone script too since it works without a running
backend deploy (e.g. first-time environment setup, or a CI/ops box that only
has DB/R2 credentials, not an HTTP path to the API).
"""

import logging

from src.avatar_gen.service import rebake_all_avatars

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def main() -> None:
    result = rebake_all_avatars()
    logger.info(
        "found %d avatar(s) with a cached source photo to rebake", result["total"]
    )
    logger.info("rebake complete: %d succeeded, %d failed", result["succeeded"], result["failed"])


if __name__ == "__main__":
    main()
