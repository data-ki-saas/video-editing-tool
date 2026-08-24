/**
 * Feature-detect gate for the free/local render button (see
 * exportTimeline.ts). Delegates to Mediabunny's own `canEncodeVideo`/
 * `canEncodeAudio`, which probe the browser's real WebCodecs encoder support
 * (not just "does the class exist") -- this is solid in Chrome/Edge, absent
 * in Firefox, and rough in Safari, so most callers will see this resolve
 * `false` outside Chromium. A representative 1080x1920 config is used since
 * encoder support can vary by resolution (e.g. H.264 level limits).
 */
import { canEncodeVideo } from "mediabunny";

const PROBE_WIDTH = 1080;
const PROBE_HEIGHT = 1920;

export async function checkLocalRenderSupport(): Promise<{ supported: boolean; reason?: string }> {
  if (typeof window === "undefined" || typeof VideoEncoder === "undefined" || typeof OfflineAudioContext === "undefined") {
    return { supported: false, reason: "Free render needs a browser with WebCodecs support (Chrome or Edge)." };
  }

  // Only video encode support gates the button -- exportTimeline.ts falls
  // back through AAC -> Opus/WebM -> silent video for audio, so a browser
  // that can encode video but not audio can still produce something.
  const videoOk = await canEncodeVideo("avc", { width: PROBE_WIDTH, height: PROBE_HEIGHT }).catch(() => false);
  if (!videoOk) return { supported: false, reason: "Free render needs Chrome or Edge." };
  return { supported: true };
}
