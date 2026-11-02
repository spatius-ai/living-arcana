/**
 * Mic-side PCM helpers for the streaming STT leg of the duplex client.
 * (The TTS-side byte-carry lives in src/spatius/pcmFrames.js; this is the
 * opposite direction: Float32 AudioWorklet frames -> s16le for the wire.)
 */

export function floatFrameToInt16(frame) {
  const out = new Int16Array(frame.length);
  for (let i = 0; i < frame.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, frame[i]));
    out[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return out;
}

/**
 * Rolling buffer of the most recent ~maxMs of Int16 frames. The VAD needs a
 * few voiced ticks to call speech onset, so by then the first syllable has
 * already played out — this buffer is flushed into the socket at onset so the
 * transcript doesn't lose the opening of the utterance.
 */
export function createPreRollBuffer(maxMs, sampleRate) {
  const maxSamples = Math.max(1, Math.round((maxMs / 1000) * sampleRate));
  let frames = [];
  let total = 0;
  return {
    push(frame) {
      frames.push(frame);
      total += frame.length;
      while (total > maxSamples && frames.length > 1) total -= frames.shift().length;
    },
    flush() {
      const out = frames;
      frames = [];
      total = 0;
      return out;
    },
    clear() {
      frames = [];
      total = 0;
    },
    size() {
      return total;
    },
  };
}
