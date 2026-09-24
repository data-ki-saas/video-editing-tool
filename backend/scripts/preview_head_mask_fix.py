"""Read-only preview of the face-oval head-cut fix in atlas_builder.py (the
photo-avatar head used to be masked with a plain circle/ellipse regardless of
the wearer's real face shape; it's now masked with their own face_oval
contour, stretched to the same coverage). Pulls ONE real avatar's cached
fal.ai cartoonify photo from R2 (no DB/R2 writes, no fal.ai spend) and saves
the resulting head crop + mask locally so the shape can be eyeballed against
a real photo before running scripts/rebake_avatars.py to roll it out to every
existing avatar.

    uv run python scripts/preview_head_mask_fix.py [design_id]

With no design_id, previews the first avatar found with a cached source
photo (repository.list_with_source_cartoon). Writes
head_mask_preview_<design_id>.png (the new mask) and
head_mask_preview_<design_id>_atlas.png (the full rebaked atlas) into the
current directory.
"""

import logging
import sys

from src.avatar_gen import repository
from src.avatar_gen.atlas_builder import build_atlas_png_from_photo, _face_oval_head_mask
from src.avatar_gen.photo_analysis import analyze_photo
from src.storage import r2_client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def main() -> None:
    target_id = sys.argv[1] if len(sys.argv) > 1 else None

    records = repository.list_with_source_cartoon()
    if not records:
        logger.info("no avatars with a cached source photo found")
        return

    record = next((r for r in records if r.id == target_id), records[0]) if target_id else records[0]
    logger.info("previewing design_id=%s user_id=%s", record.id, record.user_id)

    cartoon_bytes = r2_client.download_object(record.source_cartoon_key)
    palette = analyze_photo(cartoon_bytes)
    if not palette.detected:
        logger.warning("face-analysis didn't detect a face for this cached photo -- nothing to preview")
        return

    mask = _face_oval_head_mask(palette.face_oval, palette.head_crop_box)
    mask_path = f"head_mask_preview_{record.id}.png"
    mask.save(mask_path)
    logger.info("wrote %s (the new head-cut mask alone, white = kept)", mask_path)

    atlas_png, *_ = build_atlas_png_from_photo(cartoon_bytes, palette)
    atlas_path = f"head_mask_preview_{record.id}_atlas.png"
    with open(atlas_path, "wb") as f:
        f.write(atlas_png)
    logger.info("wrote %s (the full rebaked atlas -- head is the top-left rect)", atlas_path)


if __name__ == "__main__":
    main()
