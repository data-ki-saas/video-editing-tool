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

// How long the poll loop keeps checking before giving up -- surfaced in
// describeMattingGaveUp's own message below, kept as one constant so that
// message can't silently drift from the loop's real budget.
export const MAX_POLL_SECONDS = (MAX_ATTEMPTS * POLL_INTERVAL_MS) / 1000;

/** Polls GET /api/matting/status/{sourceAssetId} until it reaches a
 * terminal status or the attempt budget runs out. Returns the last-seen
 * state either way -- same "timeout looks like a slow waiting, not a hard
 * error" reasoning as avatarGeneration.ts's pollAvatarGeneration, which this
 * mirrors. Called after CutawayDialog's "Remove background" toggle fires
 * requestBackgroundRemoval.
 *
 * `onProgress`, if given, is called each time a wait begins: with an
 * ESTIMATED 0..1 fraction (see estimateProgress above, purely for a
 * friendlier badge -- MattingProgressBadge -- not a real signal from the
 * provider) plus the real elapsed time and attempt number, which ARE real
 * measurements -- FeedbackArea's activity log uses those two (via
 * describeMattingTick below) to prove this is still actively polling,
 * since fal.ai's own webhook-only integration otherwise gives no visible
 * sign anything is happening at all while it waits. */
export async function pollBackgroundRemoval(
  sourceAssetId: string,
  onProgress?: (fraction: number, elapsedMs: number, attempt: number) => void
): Promise<BackgroundRemoval> {
  const startedAt = Date.now();
  let last = await getBackgroundRemoval(sourceAssetId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS && last.status === "waiting"; attempt++) {
    const elapsedMs = Date.now() - startedAt;
    onProgress?.(estimateProgress(elapsedMs), elapsedMs, attempt);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    last = await getBackgroundRemoval(sourceAssetId);
  }
  return last;
}

// Rotates through a handful of phrasings for the SAME event (still waiting
// on a poll tick) so FeedbackArea's activity log reads as a chatty running
// commentary rather than the same line repeating for up to two minutes
// straight -- picked by `attempt` so it's deterministic (no per-render
// re-roll), not random.
const MATTING_TICK_PHRASES: ((seconds: number) => string)[] = [
  (s) => `Still waiting on fal.ai… (${s}s)`,
  (s) => `fal.ai hasn't replied yet — checking again… (${s}s)`,
  (s) => `No word from fal.ai yet, still polling… (${s}s)`,
  (s) => `Hang tight, fal.ai is still working on it… (${s}s)`,
];

/** A chatty one-liner for one poll tick -- see pollBackgroundRemoval's
 * `onProgress` above for where elapsedMs/attempt come from. */
export function describeMattingTick(elapsedMs: number, attempt: number): string {
  const seconds = Math.round(elapsedMs / 1000);
  return MATTING_TICK_PHRASES[attempt % MATTING_TICK_PHRASES.length](seconds);
}
