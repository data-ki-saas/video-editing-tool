import { getBackgroundRemoval, type BackgroundRemoval } from "@/lib/api";

const POLL_INTERVAL_MS = 3000;
const MAX_ATTEMPTS = 40; // ~2min, well past VEED's typical few-seconds-per-clip processing time

/** Polls GET /api/matting/status/{sourceAssetId} until it reaches a
 * terminal status or the attempt budget runs out. Returns the last-seen
 * state either way -- same "timeout looks like a slow waiting, not a hard
 * error" reasoning as avatarGeneration.ts's pollAvatarGeneration, which this
 * mirrors. Called after CutawayDialog's "Remove background" toggle fires
 * requestBackgroundRemoval. */
export async function pollBackgroundRemoval(sourceAssetId: string): Promise<BackgroundRemoval> {
  let last = await getBackgroundRemoval(sourceAssetId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS && last.status === "waiting"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    last = await getBackgroundRemoval(sourceAssetId);
  }
  return last;
}
