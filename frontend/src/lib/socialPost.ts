import { getSocialPost, type SocialPost } from "@/lib/api";

const POLL_INTERVAL_MS = 3000;
const MAX_ATTEMPTS = 60; // ~3 minutes -- a resumable upload of a multi-minute reel can take a while

/** Polls GET /api/social/posts/{id} until it reaches a terminal status or
 * the attempt budget runs out. Returns the last-seen state either way, same
 * "a timeout looks like a slow 'processing', not a hard error" convention as
 * lib/avatarGeneration.ts's pollAvatarGeneration. */
export async function pollSocialPost(id: string): Promise<SocialPost> {
  let last = await getSocialPost(id);
  for (let attempt = 0; attempt < MAX_ATTEMPTS && last.status === "processing"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    last = await getSocialPost(id);
  }
  return last;
}
