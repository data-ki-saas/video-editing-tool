import { getAvatarGeneration, type AvatarGeneration } from "@/lib/api";

const POLL_INTERVAL_MS = 4000;
const MAX_ATTEMPTS = 25; // ~100s, a bit past HeyGen's typical 30-60s generation time

/** Polls GET /api/avatar/generations/{id} until it reaches a terminal
 * status or the attempt budget runs out. Returns the last-seen state
 * either way; a timeout looks the same to the caller as a slow "waiting"
 * (both should be treated as "didn't finish in time", not a hard error) --
 * see dashboard/(chrome)/new/page.tsx and TtsAvatarDialog.tsx, the two
 * callers that kick off a generation and need to wait for it. */
export async function pollAvatarGeneration(id: string): Promise<AvatarGeneration> {
  let last = await getAvatarGeneration(id);
  for (let attempt = 0; attempt < MAX_ATTEMPTS && last.status === "waiting"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    last = await getAvatarGeneration(id);
  }
  return last;
}
