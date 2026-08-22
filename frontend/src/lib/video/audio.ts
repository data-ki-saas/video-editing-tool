/**
 * Client-side audio handling. Two callers use this:
 *  - the Playground's volume graph (extractVolumeProfile), which hands raw
 *    samples to video_math.ts's pure RMS calculation
 *  - CanvasPlayer's audio playback (decodeAudioBuffer), which plays the
 *    decoded buffer back through an AudioBufferSourceNode instead of an
 *    HTMLMediaElement
 * Both share the same fetch+decode step below.
 *
 * Same CORS requirement as video.ts's frame extraction: the R2 uploads
 * bucket needs a CORS policy allowing this origin, or fetch() below is
 * rejected outright (see backend/scripts/configure_r2_cors.py).
 */
import { computeVolumeBuckets } from "./video_math";

// Safari still exposes this under a vendor prefix.
type AudioContextConstructor = typeof AudioContext;
function getAudioContextConstructor(): AudioContextConstructor {
  const ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  if (!ctor) throw new Error("Web Audio API is not supported in this browser");
  return ctor;
}

/** Mixes a (possibly multi-channel) AudioBuffer down to a single mono
 * Float32Array by averaging channels -- the volume graph shows overall
 * loudness, not per-channel detail. */
function toMonoSamples(audioBuffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(audioBuffer.length);
  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);
    for (let i = 0; i < channelData.length; i++) {
      mono[i] += channelData[i] / audioBuffer.numberOfChannels;
    }
  }
  return mono;
}

/** Duration-only probe for a background track (or any plain audio file) --
 * mirrors video.ts's getVideoDuration but for an <audio> element. The
 * Playground's background-track strip only needs a track's length to
 * compute how many times it loops across the video, not its decoded
 * samples, so this avoids a full fetch+decode for that. */
export function getAudioDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    audio.src = url;
    audio.onloadedmetadata = () => resolve(audio.duration);
    audio.onerror = () => {
      reject(new Error(`Could not load background track: ${audio.error?.message ?? "unknown error"}`));
    };
  });
}

/**
 * Fetches and decodes the audio track at `url`. Uses its own short-lived
 * AudioContext for the decode itself -- a decoded AudioBuffer is a plain
 * data object, not tied to the context that produced it, so callers (e.g.
 * CanvasPlayer) are free to play it back through a different, longer-lived
 * AudioContext of their own.
 */
export async function decodeAudioBuffer(url: string): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch audio track (HTTP ${response.status})`);
  const arrayBuffer = await response.arrayBuffer();

  const AudioContextCtor = getAudioContextConstructor();
  const audioContext = new AudioContextCtor();
  try {
    return await audioContext.decodeAudioData(arrayBuffer);
  } finally {
    void audioContext.close();
  }
}

/**
 * Returns one normalized loudness value (0..1) per `bucketSeconds` window
 * across the whole clip at `url`, for the Playground's volume graph.
 */
export async function extractVolumeProfile(url: string, bucketSeconds: number): Promise<number[]> {
  const audioBuffer = await decodeAudioBuffer(url);
  const monoSamples = toMonoSamples(audioBuffer);
  return computeVolumeBuckets(monoSamples, audioBuffer.sampleRate, bucketSeconds);
}
