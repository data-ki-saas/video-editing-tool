"use client";

/**
 * One static HEAD-ONLY crop for an avatar gallery card -- deliberately NOT
 * drawAvatar's full-body bone/pose pipeline (used for a live preview or the
 * real editor canvas, where a full-body character genuinely belongs). A
 * picker/library card's job is "which face is this," and drawAvatar's
 * "fit the whole rig by height" scaling, applied to a small aspect-square
 * box, shrinks the head part to a sliver of its own source size -- fine
 * detail (eyes, eyebrows, Phase-6-generated contour features) doesn't
 * survive that downscale, even though the source atlas itself renders them
 * correctly. So this bypasses bones/pose entirely and draws the "head"
 * CompiledPart's own atlasRect straight from the atlas image, scaled to fill
 * the card by its own aspect ratio (contain-fit, top-anchored so there's
 * breathing room below rather than dead space above) -- the head fills the
 * thumbnail the way a profile picture would, not a tiny figure standing in a
 * tall box. The mouth is a SEPARATE CompiledPart (its own atlasRect, drawn
 * from mouthShapes.closed for a static idle look) that isn't inside the
 * head's own atlasRect at all. Both "head" and "mouth" ride the SAME bone in
 * every topology this app has (biped-simple), so their relative position is
 * just their PIVOT difference, without needing the full bone/world-matrix
 * machinery renderer.ts's drawAvatar uses: drawImage places a part such that
 * its own (pivotX, pivotY) lands at the bone's world origin, so two
 * same-bone parts' top-left corners differ by exactly
 * (partA.pivot - partB.pivot). Skipped (falls back to head-only) if a future
 * topology ever puts the mouth on a different bone.
 *
 * Shared by AvatarFramingDialog.tsx's own gallery cards (the in-editor
 * picker) and the standalone /avatars library page, so both render an
 * identical head-crop for the same avatarId.
 */
import { useEffect, useRef } from "react";
import { getCompiledAvatar } from "@/lib/video/avatar/compile";

export function AvatarThumbnailCanvas({ avatarId, className }: { avatarId: string; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    getCompiledAvatar(avatarId)
      .then((compiled) => {
        if (cancelled) return;
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const width = Math.max(1, Math.round(canvas.getBoundingClientRect().width));
        const height = Math.max(1, Math.round(canvas.getBoundingClientRect().height));
        // Render at devicePixelRatio so fine features (thin eyebrow
        // strokes, small eye shapes) get real source pixels to downscale
        // from instead of blurring away on a high-DPI screen.
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // Default "low" undoes the dpr bump above by blurring/aliasing the
        // small eyebrow/eye atlas rects on the upscale (see CanvasPlayer.tsx's
        // own identical fix) -- reads as jagged brow strokes otherwise.
        ctx.imageSmoothingQuality = "high";

        const headPart = compiled.skin.parts.find((part) => part.partId === "head");
        if (!headPart) return;
        const { atlasRect } = headPart;
        const scale = Math.min(width / atlasRect.sWidth, height / atlasRect.sHeight);
        const drawWidth = atlasRect.sWidth * scale;
        const drawHeight = atlasRect.sHeight * scale;
        const destX = (width - drawWidth) / 2;
        const destY = Math.max(0, (height - drawHeight) * 0.15); // top-anchored, not dead-centered
        ctx.drawImage(
          compiled.skin.atlasImage,
          atlasRect.sx,
          atlasRect.sy,
          atlasRect.sWidth,
          atlasRect.sHeight,
          destX,
          destY,
          drawWidth,
          drawHeight
        );

        const mouthPart = compiled.skin.mouthShapes.closed ?? compiled.skin.parts.find((part) => part.partId === "mouth");
        if (mouthPart && mouthPart.boneIndex === headPart.boneIndex) {
          const mouthRect = mouthPart.atlasRect;
          const mouthDestX = destX + (headPart.pivotX - mouthPart.pivotX) * scale;
          const mouthDestY = destY + (headPart.pivotY - mouthPart.pivotY) * scale;
          ctx.drawImage(
            compiled.skin.atlasImage,
            mouthRect.sx,
            mouthRect.sy,
            mouthRect.sWidth,
            mouthRect.sHeight,
            mouthDestX,
            mouthDestY,
            mouthRect.sWidth * scale,
            mouthRect.sHeight * scale
          );
        }
      })
      .catch((err) => {
        console.error("Avatar thumbnail compile failed for avatarId=%s", avatarId, err);
      });
    return () => {
      cancelled = true;
    };
  }, [avatarId]);

  return <canvas ref={canvasRef} className={className} />;
}
