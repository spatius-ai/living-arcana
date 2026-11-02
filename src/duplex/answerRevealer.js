/**
 * Subtitle-style answer reveal.
 *
 * The LLM streams text far faster than the avatar can speak it, so painting
 * deltas as they arrive leaves a long "text is done, avatar still silent"
 * gap that reads as latency. This paces the visible answer to the avatar's
 * audio instead: nothing shows until the first PCM is actually fed, then
 * characters are revealed on an estimated speech clock.
 *
 * The clock needs no support from AvatarKit: PCM is s16le 16 kHz mono, so
 * playback advances at 32 bytes/ms starting roughly when the first chunk is
 * fed (plus a small prebuffer allowance), and can never be ahead of the
 * bytes fed so far. Characters are mapped onto that clock with a rough
 * per-character duration model (CJK syllables are slow, latin letters fast,
 * punctuation pauses); once the full audio length is known the remaining
 * schedule is rescaled to it, so the model only has to be right-ish.
 *
 * Failure shapes never hide text: if no audio arrives at all (TTS down, no
 * key) a stall timeout degrades to immediate reveal; when the avatar gives
 * up mid-turn the caller snap()s the full text out; barge-in and error
 * messages stop the reveal via cancel() (frozen where the voice stopped).
 *
 * Pure logic — the caller owns the interval that drives tick().
 */

export const PCM_BYTES_PER_MS = 32; // s16le 16 kHz mono

// CJK punctuation: 。！？；：，、…—
const CJK_PUNCT = /[。！？；：，、…—]/;
// Kana, Han (incl. compatibility ideographs), Hangul — one syllable a beat.
const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

export function charDurationMs(char) {
  if (CJK_PUNCT.test(char)) return 260;
  if (CJK.test(char)) return 235;
  if (/[.!?;:]/.test(char)) return 220;
  if (/[,]/.test(char)) return 150;
  if (/\s/.test(char)) return 55;
  return 72; // latin letters/digits ≈ 14 chars/s
}

export function createAnswerRevealer({
  onReveal,
  prebufferMs = 250,
  stallTimeoutMs = 3500,
  now = () => Date.now(),
} = {}) {
  let fullText = "";
  let revealed = 0;
  let schedule = []; // cumulative estimated ms at which char i should appear
  let scheduleTotal = 0;
  let scale = 1;
  let firstTextAt = null;
  let firstPcmAt = null;
  let bytesFed = 0;
  let audioComplete = false;
  let immediate = false; // stall fallback: follow the text stream directly
  let stopped = false;

  const reveal = (upTo) => {
    if (upTo <= revealed) return;
    revealed = upTo;
    onReveal(fullText.slice(0, revealed));
  };

  return {
    setText(text) {
      if (stopped) return;
      const next = String(text || "");
      // Streams only ever grow; a shorter text is a reset (new attempt).
      if (!next.startsWith(fullText)) {
        fullText = "";
        revealed = 0;
        schedule = [];
        scheduleTotal = 0;
      }
      for (let i = fullText.length; i < next.length; i += 1) {
        scheduleTotal += charDurationMs(next[i]);
        schedule.push(scheduleTotal);
      }
      fullText = next;
      if (firstTextAt === null) firstTextAt = now();
      if (immediate) reveal(fullText.length);
    },
    notifyPcm(byteLength) {
      if (stopped || !byteLength) return;
      bytesFed += byteLength;
      if (firstPcmAt === null) firstPcmAt = now();
    },
    // Call when the final PCM has been fed: the audio length is now exact,
    // so the remaining schedule is rescaled onto it.
    markAudioComplete() {
      if (stopped) return;
      audioComplete = true;
      if (firstPcmAt !== null && bytesFed && scheduleTotal) {
        scale = Math.min(1.8, Math.max(0.6, (bytesFed / PCM_BYTES_PER_MS) / scheduleTotal));
      }
    },
    // Advance the reveal. Returns true once there is nothing left to do —
    // the caller clears its interval on that.
    tick() {
      if (stopped) return true;
      if (immediate) return audioComplete && revealed >= fullText.length;
      if (firstPcmAt === null) {
        if (firstTextAt !== null && now() - firstTextAt >= stallTimeoutMs) {
          immediate = true;
          reveal(fullText.length);
        }
        return false;
      }
      const playedMs = Math.max(0, Math.min(
        now() - firstPcmAt - prebufferMs,
        bytesFed / PCM_BYTES_PER_MS,
      ));
      let target = revealed;
      while (target < fullText.length && schedule[target] * scale <= playedMs) target += 1;
      reveal(target);
      return audioComplete && revealed >= fullText.length;
    },
    // Barge-in / a newer question: show everything that streamed, instantly.
    snap() {
      if (stopped) return;
      stopped = true;
      if (fullText.length > revealed) onReveal(fullText);
      revealed = fullText.length;
    },
    // An error message is about to take over the answer surface.
    cancel() {
      stopped = true;
    },
    revealedText() {
      return fullText.slice(0, revealed);
    },
  };
}
