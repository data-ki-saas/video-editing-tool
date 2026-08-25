/**
 * Client-side audio handling. Two callers use this:
 *  - the Playground's background-track strip (getAudioDuration), which only
 *    needs a track's length, not its decoded samples
 *  - CanvasPlayer's audio playback (decodeAudioBuffer), which plays the
 *    decoded buffer back through an AudioBufferSourceNode instead of an
 *    HTMLMediaElement
 * Both share the same fetch+decode step below.
 *
 * Same CORS requirement as video.ts's frame extraction: the R2 uploads
 * bucket needs a CORS policy allowing this origin, or fetch() below is
 * rejected outright (see backend/scripts/configure_r2_cors.py).
 */

// Safari still exposes this under a vendor prefix.
type AudioContextConstructor = typeof AudioContext;
function getAudioContextConstructor(): AudioContextConstructor {
  const ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  if (!ctor) throw new Error("Web Audio API is not supported in this browser");
  return ctor;
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
 * Concatenates decoded audio buffers into one continuous buffer, so a
 * multi-clip sequence can still be played back through a single
 * AudioBufferSourceNode -- CanvasPlayer's existing clock/seek/trim-skip
 * logic then needs no changes at all, since it just thinks it's playing
 * one longer virtual clip. `context` is the caller's own longer-lived
 * context -- an AudioContext for playback, or an OfflineAudioContext for
 * lib/localRender/exportTimeline.ts's offline mix -- not a fresh one;
 * `createBuffer` only allocates, it doesn't decode, so no separate decode
 * context is needed here.
 *
 * Assumes every buffer shares the same sample rate. In practice this holds
 * even for source files recorded at different native rates: decodeAudioBuffer
 * decodes each one through its own AudioContext, and per the Web Audio
 * spec decodeAudioData resamples to *that context's* rate -- which is the
 * same across every AudioContext instantiated with no explicit sampleRate
 * option within one browser session. No resampling is implemented here;
 * a real mismatch (unlikely per the above) would play the mismatched
 * buffer's channel data at the wrong pitch/speed.
 */
export function concatenateAudioBuffers(context: BaseAudioContext, buffers: AudioBuffer[]): AudioBuffer {
  const numberOfChannels = Math.max(...buffers.map((buffer) => buffer.numberOfChannels));
  const sampleRate = buffers[0].sampleRate;
  const totalLength = buffers.reduce((sum, buffer) => sum + buffer.length, 0);

  const combined = context.createBuffer(numberOfChannels, totalLength, sampleRate);
  let offset = 0;
  for (const buffer of buffers) {
    for (let channel = 0; channel < numberOfChannels; channel++) {
      // A buffer with fewer channels than the combined output (e.g. mono
      // source mixed with a stereo one) reuses its own channel 0 for every
      // output channel, rather than leaving the extra channel silent.
      const channelData = channel < buffer.numberOfChannels ? buffer.getChannelData(channel) : buffer.getChannelData(0);
      combined.getChannelData(channel).set(channelData, offset);
    }
    offset += buffer.length;
  }
  return combined;
}
