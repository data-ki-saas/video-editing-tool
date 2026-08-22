/**
 * Client-side audio analysis, powering the Playground's volume graph (see
 * components/editor-v2/Playground.tsx). Decodes the audio track via the Web
 * Audio API and hands the raw samples to video_math.ts's pure RMS
 * calculation -- this module only owns fetching/decoding, not the numeric
 * work itself.
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

/**
 * Fetches and decodes the audio track at `url`, returning one normalized
 * loudness value (0..1) per `bucketSeconds` window across the whole clip.
 */
export async function extractVolumeProfile(url: string, bucketSeconds: number): Promise<number[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch audio track (HTTP ${response.status})`);
  const arrayBuffer = await response.arrayBuffer();

  const AudioContextCtor = getAudioContextConstructor();
  const audioContext = new AudioContextCtor();
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const monoSamples = toMonoSamples(audioBuffer);
    return computeVolumeBuckets(monoSamples, audioBuffer.sampleRate, bucketSeconds);
  } finally {
    void audioContext.close();
  }
}
