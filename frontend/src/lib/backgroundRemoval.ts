import { getBackgroundRemoval, type BackgroundRemoval } from "@/lib/api";

const POLL_INTERVAL_MS = 3000;
const MAX_ATTEMPTS = 40; // ~2min, well past VEED's typical few-seconds-per-clip processing time

// Decay constant for the ESTIMATED progress reported via `onProgress` below
// -- fal.ai's VEED integration is webhook-only (see fal_veed_provider.py's
// own module comment); there is no interim "N% done" this app ever actually
// receives from the provider, only a final completed/failed webhook. So
// this is a fabricated curve, not a measurement: 1 - e^(-elapsed/tau) rises
// quickly at first (visible motion right away) then eases off, asymptotying
// toward -- but per PROGRESS_CAP below, never quite reaching -- 100% on its
// own, leaving the final jump to 100% for the real terminal status landing.
const PROGRESS_TIME_CONSTANT_MS = 12_000;
const PROGRESS_CAP = 0.95;

function estimateProgress(elapsedMs: number): number {
  return Math.min(PROGRESS_CAP, 1 - Math.exp(-elapsedMs / PROGRESS_TIME_CONSTANT_MS));
}

/** Polls GET /api/matting/status/{sourceAssetId} until it reaches a
 * terminal status or the attempt budget runs out. Returns the last-seen
 * state either way -- same "timeout looks like a slow waiting, not a hard
 * error" reasoning as avatarGeneration.ts's pollAvatarGeneration, which this
 * mirrors. Called after CutawayDialog's "Remove background" toggle fires
 * requestBackgroundRemoval.
 *
 * `onProgress`, if given, is called with an ESTIMATED 0..1 fraction (see
 * estimateProgress above) each time a wait begins -- purely for a friendlier
 * badge (MattingProgressBadge) while this polls, not a real signal from the
 * provider. */
export async function pollBackgroundRemoval(
  sourceAssetId: string,
  onProgress?: (fraction: number) => void
): Promise<BackgroundRemoval> {
  const startedAt = Date.now();
  let last = await getBackgroundRemoval(sourceAssetId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS && last.status === "waiting"; attempt++) {
    onProgress?.(estimateProgress(Date.now() - startedAt));
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    last = await getBackgroundRemoval(sourceAssetId);
  }
  return last;
}
