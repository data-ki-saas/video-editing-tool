/**
 * Resolves a Phase-6 "gen-*" avatarId (a user's own photo-generated
 * character, backend/src/avatar_gen/) into the same AvatarLibraryEntry shape
 * library.ts's hand-authored seed entries already provide -- the ONLY thing
 * that differs from a seed entry is where the {topology, skin, design}
 * triple came from (a network fetch instead of a module-scope constant);
 * once resolved, compile.ts/actions.ts/renderer.ts don't know or care which
 * kind of entry they're compiling. compile.ts's getCompiledAvatar falls back
 * to fetchGeneratedAvatarEntry below whenever library.ts's synchronous seed
 * lookup misses.
 */
import {
  deleteGeneratedAvatar as apiDeleteGeneratedAvatar,
  generateAvatarFromPhoto as apiGenerateAvatarFromPhoto,
  getGeneratedAvatar as apiGetGeneratedAvatar,
  listGeneratedAvatars,
  type GeneratedAvatarDetail,
  type GeneratedAvatarSummary,
} from "@/lib/api";
import type { AvatarDesign } from "./design";
import type { AvatarSkin } from "./skin";
import { BIPED_SIMPLE_TOPOLOGY, type AvatarLibraryEntry } from "./library";

export type { GeneratedAvatarSummary };

// Every entry this session has already fetched or just generated, keyed by
// designId -- generateAvatarFromPhoto's own response already carries the
// full triple, so a freshly-generated avatar's FIRST render (the gallery
// card that appears the instant generation finishes) doesn't need to
// round-trip back to the server just to re-fetch what it was already just
// given.
const knownEntries = new Map<string, AvatarLibraryEntry>();

function toEntry(detail: GeneratedAvatarDetail): AvatarLibraryEntry {
  // The api.ts boundary keeps skin/design untyped (see that file's own doc
  // comment on GeneratedAvatarDetail) -- this is the one place that narrows
  // them back to the real AvatarSkin/AvatarDesign shape, right before
  // compile.ts's own validation runs on it.
  const entry: AvatarLibraryEntry = {
    design: detail.design as AvatarDesign,
    skin: detail.skin as AvatarSkin,
    topology: BIPED_SIMPLE_TOPOLOGY,
  };
  knownEntries.set(detail.id, entry);
  return entry;
}

export async function fetchGeneratedAvatarEntry(avatarId: string): Promise<AvatarLibraryEntry | null> {
  const known = knownEntries.get(avatarId);
  if (known) return known;
  const detail = await apiGetGeneratedAvatar(avatarId);
  return detail ? toEntry(detail) : null;
}

export async function generateAvatarFromPhoto(file: File, name?: string): Promise<AvatarLibraryEntry> {
  return toEntry(await apiGenerateAvatarFromPhoto(file, name));
}

export async function listMyGeneratedAvatars(): Promise<GeneratedAvatarSummary[]> {
  return listGeneratedAvatars();
}

export async function deleteGeneratedAvatar(avatarId: string): Promise<void> {
  knownEntries.delete(avatarId);
  await apiDeleteGeneratedAvatar(avatarId);
}
