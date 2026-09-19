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
"""

import logging

from src.avatar_gen import repository
from src.avatar_gen.service import _rebake_record

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def main() -> None:
    records = repository.list_with_source_cartoon()
    logger.info("found %d avatar(s) with a cached source photo to rebake", len(records))

    succeeded = 0
    failed = 0
    for record in records:
        try:
            _rebake_record(record)
            succeeded += 1
        except Exception:
            failed += 1
            logger.exception("failed to rebake avatar design=%s user=%s", record.id, record.user_id)

    logger.info("rebake complete: %d succeeded, %d failed", succeeded, failed)


if __name__ == "__main__":
    main()
