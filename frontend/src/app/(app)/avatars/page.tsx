"use client";

/**
 * Standalone home for a creator's own generated avatars (backend/src/
 * avatar_gen/'s `avatar_designs` table) -- mirrors /library/page.tsx's own
 * shape (a plain grid, InlineEditableText rename, confirm-then-delete).
 *
 * Before this page existed, the ONLY way to see this list was AvatarFramingDialog's
 * "My avatars" gallery -- reachable only from inside a specific project's
 * editor. `avatar_designs` rows have no project_id at all (they already
 * survive a project being deleted, see that table's own migration), but
 * without a route back to them once the project that was used to reach the
 * dialog is gone, a creator had no way to find or reuse an avatar they'd
 * already generated -- which reads exactly like "my avatar got deleted."
 * This page is that missing route.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AvatarThumbnailCanvas } from "@/components/AvatarThumbnailCanvas";
import { InlineEditableText } from "@/components/InlineEditableText";
import {
  deleteGeneratedAvatar,
  generateAvatarFromPhoto,
  listMyGeneratedAvatars,
  renameGeneratedAvatar,
  type GeneratedAvatarSummary,
} from "@/lib/video/avatar/generatedLibrary";
import { FeatureLockedError } from "@/lib/api";
import { UpgradeRequiredDialog } from "@/components/UpgradeRequiredDialog";

function AvatarCard({
  avatar,
  onRename,
  onDelete,
}: {
  avatar: GeneratedAvatarSummary;
  onRename: (id: string, name: string) => void;
  onDelete: (avatar: GeneratedAvatarSummary) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-2">
      <div className="relative aspect-square w-full overflow-hidden rounded-md bg-black">
        <AvatarThumbnailCanvas avatarId={avatar.id} className="absolute inset-0 h-full w-full" />
        <button
          type="button"
          onClick={() => onDelete(avatar)}
          title="Delete"
          aria-label="Delete this avatar"
          className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-white hover:bg-black/80"
        >
          ✕
        </button>
      </div>
      <InlineEditableText
        value={avatar.name}
        onCommit={(name) => onRename(avatar.id, name)}
        ariaLabel="Avatar name"
        className="w-full truncate text-center text-xs font-medium text-foreground"
        inputClassName="block w-full truncate rounded border border-border bg-background px-1 text-center text-xs text-foreground outline-none"
      />
    </div>
  );
}

export default function AvatarsPage() {
  const [avatars, setAvatars] = useState<GeneratedAvatarSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [lockedError, setLockedError] = useState<FeatureLockedError | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listMyGeneratedAvatars()
      .then(setAvatars)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load your avatars"));
  }, []);

  async function handleRename(id: string, name: string) {
    const previous = avatars?.find((a) => a.id === id)?.name;
    setAvatars((prev) => prev?.map((a) => (a.id === id ? { ...a, name } : a)) ?? prev);
    try {
      await renameGeneratedAvatar(id, name);
    } catch (err) {
      console.error("Failed to rename avatar", err);
      if (previous !== undefined) setAvatars((prev) => prev?.map((a) => (a.id === id ? { ...a, name: previous } : a)) ?? prev);
      setError(err instanceof Error ? err.message : "Failed to rename this avatar");
    }
  }

  async function handleDelete(avatar: GeneratedAvatarSummary) {
    if (!window.confirm(`Delete "${avatar.name}"? This can't be undone.`)) return;
    const previousIndex = avatars?.findIndex((a) => a.id === avatar.id) ?? -1;
    setAvatars((prev) => prev?.filter((a) => a.id !== avatar.id) ?? prev);
    try {
      await deleteGeneratedAvatar(avatar.id);
    } catch (err) {
      setAvatars((prev) => {
        if (!prev) return prev;
        const next = [...prev];
        next.splice(previousIndex < 0 ? next.length : previousIndex, 0, avatar);
        return next;
      });
      setError(err instanceof Error ? err.message : "Failed to delete this avatar");
    }
  }

  async function handlePhotoPicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow picking the same file again later
    if (!file || isGenerating) return;
    setIsGenerating(true);
    setGenerateError(null);
    try {
      const { entry, faceDetected } = await generateAvatarFromPhoto(file);
      setAvatars((prev) => [
        { id: entry.design.designId, name: entry.design.meta.name, thumbnailUrl: null, createdAt: new Date().toISOString() },
        ...(prev ?? []),
      ]);
      if (!faceDetected) {
        setGenerateError("Couldn't detect a face in that photo, so this uses a default look instead of your photo. Try a clearer, front-facing, well-lit photo.");
      }
    } catch (err) {
      if (err instanceof FeatureLockedError) setLockedError(err);
      else setGenerateError(err instanceof Error ? err.message : "Couldn't generate an avatar from that photo");
    } finally {
      setIsGenerating(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-12">
      <div>
        <Link href="/dashboard" className="text-sm text-muted hover:underline">
          ← Reels
        </Link>
        <h1 className="text-2xl font-semibold">My Avatars</h1>
        <p className="text-sm text-muted">
          Characters you&apos;ve generated from a photo, kept here independent of any reel -- reusable across projects, and
          safe even if a reel that used one is deleted.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
      {!error && !avatars && <p className="text-sm text-muted">Loading…</p>}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
        {avatars?.map((avatar) => (
          <AvatarCard key={avatar.id} avatar={avatar} onRename={handleRename} onDelete={handleDelete} />
        ))}

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isGenerating}
          className="flex aspect-square flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-border p-1.5 text-xs text-muted hover:bg-surface disabled:opacity-50"
        >
          <span className="text-2xl">{isGenerating ? "…" : "+"}</span>
          <span>{isGenerating ? "Generating…" : "From a photo"}</span>
        </button>
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={handlePhotoPicked} />
      </div>
      {generateError && <p className="text-[11px] text-red-600">{generateError}</p>}
      {lockedError && <UpgradeRequiredDialog error={lockedError} onClose={() => setLockedError(null)} />}
    </main>
  );
}
