/**
 * Full-duplex voice conversation with the daily card.
 *
 * The microphone stays open for the whole conversation. A lightweight local
 * voice-activity detector (AnalyserNode RMS with onset/hangover thresholds)
 * finds utterance boundaries and drives the instant, local barge-in.
 *
 * Transcription has two legs:
 *
 * 1. Streaming (preferred): a same-origin WebSocket to
 *    /api/arcana/stt-socket relays mic PCM to ElevenLabs realtime Scribe
 *    while the user is speaking (an AudioWorklet tap + a short pre-roll ring
 *    so the VAD's onset lag loses nothing). At the VAD boundary a manual
 *    commit fetches the finished transcript in ~100-300 ms — the ~0.7 s
 *    post-utterance batch round-trip disappears from the critical path.
 *    Audio only flows while the VAD hears speech, so silence costs nothing.
 *
 * 2. Batch (fallback + safety net): MediaRecorder keeps recording exactly as
 *    before. If the socket is unavailable/failed the old behavior runs
 *    unchanged (speculative upload included); if a streaming commit fails or
 *    times out, the local recording of that same utterance is posted to
 *    /api/arcana/transcribe so the turn is never lost.
 */

import { createPreRollBuffer, floatFrameToInt16 } from "./micPcm.js";
import { fetchWithTimeout } from "../reading/fetchWithTimeout.js";

const VAD_TICK_MS = 60;
const SPEECH_ONSET_FRAMES = 3; // consecutive voiced ticks to count as speech
const SPEECH_END_SILENCE_MS = 550;
// Speculative transcription: once silence has lasted this long, the segment
// recorded so far is already posted to /transcribe while the VAD keeps
// waiting for the real SPEECH_END_SILENCE_MS boundary. If the user resumes
// before the boundary, the resumed speech records as a further segment and
// the texts are joined — so the utterance semantics are unchanged, but the
// STT round-trip overlaps the silence tail (~270ms saved per turn).
const SPECULATIVE_SILENCE_MS = 280;
const MAX_UTTERANCE_MS = 30_000;
const IDLE_RECYCLE_MS = 8_000; // restart recorder to drop buffered silence
const MIN_UTTERANCE_BLOB_BYTES = 4_096;
const RMS_THRESHOLD = 0.02;
// Streaming STT leg. Pre-roll covers the VAD's onset lag (3 ticks ≈ 180 ms)
// with margin; the commit timeout is the point where waiting on the socket
// stops beating the batch fallback that is already recorded locally.
const STREAM_PREROLL_MS = 360;
const STT_READY_TIMEOUT_MS = 4_000;
const STT_COMMIT_TIMEOUT_MS = 3_500;

// The worklet only taps the mic graph: it batches ~43 ms (2048 samples) of
// Float32 input per message so the main thread isn't woken every 128 frames.
const MIC_TAP_WORKLET = `
class ArcanaMicTap extends AudioWorkletProcessor {
  constructor() { super(); this.pending = []; this.length = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      this.pending.push(channel.slice(0));
      this.length += channel.length;
      if (this.length >= 2048) {
        const merged = new Float32Array(this.length);
        let offset = 0;
        for (const chunk of this.pending) { merged.set(chunk, offset); offset += chunk.length; }
        this.pending = []; this.length = 0;
        this.port.postMessage(merged, [merged.buffer]);
      }
    }
    return true;
  }
}
registerProcessor("arcana-mic-tap", ArcanaMicTap);
`;

function pickRecordingMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
}

// 0.15 s of 16 kHz s16le silence in a WAV container. Posted once when a
// conversation starts so the transcribe path (TLS, OpenRouter routing, model
// spin-up) is warm before the user's first real utterance.
function buildSilentWav() {
  const samples = 2400;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
  writeAscii(0, "RIFF"); view.setUint32(4, 36 + samples * 2, true); writeAscii(8, "WAVE");
  writeAscii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeAscii(36, "data"); view.setUint32(40, samples * 2, true);
  return new Blob([buffer], { type: "audio/wav" });
}

export function isDuplexSupported() {
  return Boolean(
    typeof window !== "undefined"
    && typeof MediaRecorder !== "undefined"
    && window.AudioContext
    && navigator.mediaDevices?.getUserMedia,
  );
}

export class ArcanaDuplexUnavailableError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ArcanaDuplexUnavailableError";
    this.status = status;
  }
}

export function createArcanaDuplexClient({
  transcribeEndpoint = "/api/arcana/transcribe",
  sttSocketEndpoint = "/api/arcana/stt-socket",
  onUserUtterance = () => {},
  onPartialTranscript = () => {},
  onBargeIn = () => {},
  onStateChange = () => {},
  onError = () => {},
  onEnd = () => {},
} = {}) {
  let running = false;
  let mediaStream = null;
  let audioContext = null;
  let analyser = null;
  let sourceNode = null;
  let recorder = null;
  let chunks = [];
  let segmentConsumer = null;
  let vadTimer = 0;
  let voicedFrames = 0;
  let userSpeaking = false;
  let speculated = false;
  let segmentHasVoice = false;
  let pendingSegments = [];
  let speechStartedAt = 0;
  let lastVoiceAt = 0;
  let lastBoundaryAt = 0;
  let mimeType = "";
  // Streaming STT leg (null until the socket dials; failed sessions stay
  // around so we don't redial mid-conversation).
  let stt = null; // { socket, ready, failed, pendingCommit, readyTimer }
  let streamingUtterance = false;
  let preRoll = null;
  let micTapNode = null;
  let micTapGain = null;
  let workletUrl = "";

  const setState = (state) => onStateChange(state);

  const sttReady = () => Boolean(stt && stt.ready && !stt.failed);

  // A failed streaming session is left in place (no mid-conversation
  // redials); every later utterance takes the batch path from onset.
  const markSttFailed = () => {
    if (!stt || stt.failed) return;
    stt.failed = true;
    streamingUtterance = false;
    window.clearTimeout(stt.readyTimer);
    const settle = stt.pendingCommit;
    stt.pendingCommit = null;
    try { stt.socket.close(); } catch { /* already closed */ }
    settle?.({ ok: false });
  };

  const teardownStt = () => {
    const session = stt;
    stt = null;
    streamingUtterance = false;
    if (session) {
      window.clearTimeout(session.readyTimer);
      const settle = session.pendingCommit;
      session.pendingCommit = null;
      try { session.socket.close(); } catch { /* already closed */ }
      settle?.({ ok: false });
    }
    micTapNode?.disconnect();
    micTapNode = null;
    micTapGain?.disconnect();
    micTapGain = null;
    if (workletUrl) URL.revokeObjectURL(workletUrl);
    workletUrl = "";
    preRoll = null;
  };

  const sendPcm = (int16) => {
    try {
      stt.socket.send(int16.buffer);
      return true;
    } catch {
      markSttFailed();
      return false;
    }
  };

  const handleMicFrame = (frame) => {
    if (!sttReady()) return;
    const pcm = floatFrameToInt16(frame);
    if (streamingUtterance) sendPcm(pcm);
    else preRoll?.push(pcm);
  };

  // Resolves with { ok, text } — ok:false routes the utterance to the batch
  // safety net. A timed-out commit also fails the whole streaming session:
  // its transcript positions are no longer trustworthy.
  const sttCommit = () => {
    if (!sttReady()) return Promise.resolve({ ok: false });
    const session = stt;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        if (session.pendingCommit === settle) session.pendingCommit = null;
        markSttFailed();
        resolve({ ok: false });
      }, STT_COMMIT_TIMEOUT_MS);
      const settle = (result) => {
        window.clearTimeout(timer);
        resolve(result);
      };
      session.pendingCommit = settle;
      try {
        session.socket.send(JSON.stringify({ type: "commit" }));
      } catch {
        session.pendingCommit = null;
        markSttFailed();
        settle({ ok: false });
      }
    });
  };

  const startStreamingStt = async () => {
    if (typeof WebSocket !== "function" || !audioContext?.audioWorklet) return;
    try {
      workletUrl = URL.createObjectURL(new Blob([MIC_TAP_WORKLET], { type: "text/javascript" }));
      await audioContext.audioWorklet.addModule(workletUrl);
      if (!running || !sourceNode) return;
      micTapNode = new AudioWorkletNode(audioContext, "arcana-mic-tap", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      // A silent path to the destination keeps the tap processing.
      micTapGain = audioContext.createGain();
      micTapGain.gain.value = 0;
      sourceNode.connect(micTapNode);
      micTapNode.connect(micTapGain);
      micTapGain.connect(audioContext.destination);
      micTapNode.port.onmessage = (event) => handleMicFrame(event.data);
      preRoll = createPreRollBuffer(STREAM_PREROLL_MS, audioContext.sampleRate);

      const scheme = window.location.protocol === "https:" ? "wss://" : "ws://";
      const socket = new WebSocket(`${scheme}${window.location.host}${sttSocketEndpoint}`);
      socket.binaryType = "arraybuffer";
      const session = { socket, ready: false, failed: false, pendingCommit: null, readyTimer: 0 };
      stt = session;
      session.readyTimer = window.setTimeout(markSttFailed, STT_READY_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        if (stt !== session || session.failed) return;
        try {
          socket.send(JSON.stringify({ type: "init", sampleRate: audioContext.sampleRate }));
        } catch {
          markSttFailed();
        }
      });
      socket.addEventListener("message", (event) => {
        if (stt !== session || session.failed || typeof event.data !== "string") return;
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (payload?.type === "ready") {
          session.ready = true;
          window.clearTimeout(session.readyTimer);
          return;
        }
        if (payload?.type === "partial") {
          if (userSpeaking || streamingUtterance || session.pendingCommit) onPartialTranscript(String(payload.text || ""));
          return;
        }
        if (payload?.type === "committed") {
          const settle = session.pendingCommit;
          session.pendingCommit = null;
          settle?.({ ok: true, text: String(payload.text || "").trim() });
          return;
        }
        if (payload?.type === "error") markSttFailed();
      });
      socket.addEventListener("close", () => {
        if (stt === session) markSttFailed();
      });
      socket.addEventListener("error", () => {
        if (stt === session) markSttFailed();
      });
    } catch {
      markSttFailed();
    }
  };

  // Streaming boundary: the audio has already been heard upstream, so the
  // commit round-trip is all that stands between silence and the LLM. The
  // batch recording of this same utterance stays as the safety net.
  const finishStreamingUtterance = () => {
    streamingUtterance = false;
    let resolveBackup;
    const backup = new Promise((resolve) => { resolveBackup = resolve; });
    if (segmentHasVoice) stopRecorder((blob) => resolveBackup(blob));
    else resolveBackup(null);
    setState("transcribing");
    void sttCommit().then(async (committed) => {
      if (committed.ok) {
        if (committed.text) onUserUtterance(committed.text);
      } else {
        const blob = await backup;
        const result = blob ? await transcribeBlob(blob) : { ok: true, text: "" };
        if (result.ok) {
          if (result.text) onUserUtterance(result.text);
        } else if (!result.fatal) {
          onError(result.network
            ? "Your voice couldn't reach the server. Check the connection and speak again."
            : "Your voice couldn't be transcribed this time. Speak again, or type the question.", { fatal: false });
        }
      }
      if (running) setState("listening");
    });
  };

  const startRecorder = () => {
    if (!running || !mediaStream) return;
    chunks = [];
    segmentConsumer = null;
    segmentHasVoice = false;
    recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      const blob = new Blob(chunks, { type: recorder?.mimeType || mimeType || "audio/webm" });
      const consume = segmentConsumer;
      segmentConsumer = null;
      lastBoundaryAt = performance.now();
      startRecorder();
      if (consume) consume(blob);
    });
    recorder.start();
  };

  const stopRecorder = (consumer) => {
    if (!recorder || recorder.state === "inactive") return;
    segmentConsumer = consumer || null;
    try { recorder.stop(); } catch { recorder = null; }
  };

  // Transcribes one recorded segment. Resolves instead of dispatching so an
  // utterance can span several segments (see SPECULATIVE_SILENCE_MS).
  const transcribeBlob = async (blob) => {
    if (blob.size < MIN_UTTERANCE_BLOB_BYTES) return { ok: true, text: "" };
    try {
      const response = await fetchWithTimeout(transcribeEndpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      }, 45_000);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 503) {
          onError("Voice input isn't configured on this deployment yet—type your question instead.", { fatal: true });
          stop({ reason: "not-configured" });
          return { ok: false, fatal: true };
        }
        return { ok: false };
      }
      return { ok: true, text: String(payload?.text || "").trim() };
    } catch {
      return { ok: false, network: true };
    }
  };

  const captureSegment = () => {
    stopRecorder((blob) => pendingSegments.push(transcribeBlob(blob)));
  };

  const finishUtterance = () => {
    const segments = pendingSegments;
    pendingSegments = [];
    if (!segments.length) return;
    setState("transcribing");
    void Promise.all(segments).then((parts) => {
      const failed = parts.filter((part) => !part.ok);
      if (failed.length) {
        if (!failed.some((part) => part.fatal)) {
          onError(failed.some((part) => part.network)
            ? "Your voice couldn't reach the server. Check the connection and speak again."
            : "Your voice couldn't be transcribed this time. Speak again, or type the question.", { fatal: false });
        }
      } else {
        const text = parts.map((part) => part.text).filter(Boolean).join(" ").trim();
        if (text) onUserUtterance(text);
      }
      if (running) setState("listening");
    });
  };

  const measureRms = () => {
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i += 1) {
      const deviation = (data[i] - 128) / 128;
      sum += deviation * deviation;
    }
    return Math.sqrt(sum / data.length);
  };

  const vadTick = () => {
    if (!running || !analyser) return;
    const now = performance.now();
    const voiced = measureRms() >= RMS_THRESHOLD;

    if (voiced) {
      voicedFrames += 1;
      lastVoiceAt = now;
      segmentHasVoice = true;
      if (userSpeaking) {
        // Resumed within the utterance window: a later pause may speculate
        // again for the next segment.
        speculated = false;
      } else if (voicedFrames >= SPEECH_ONSET_FRAMES) {
        userSpeaking = true;
        speechStartedAt = now;
        // The streaming/batch choice is made per utterance at onset, so a
        // socket that comes up (or dies) mid-conversation is picked up on
        // the next thing the user says.
        if (sttReady()) {
          streamingUtterance = true;
          for (const pcm of preRoll?.flush() || []) {
            if (!sendPcm(pcm)) break;
          }
        }
        // Local, instant barge-in: cut avatar speech as soon as the user talks.
        onBargeIn();
      }
    } else {
      voicedFrames = 0;
    }

    if (userSpeaking) {
      const silenceFor = now - lastVoiceAt;
      const speakingFor = now - speechStartedAt;
      if (silenceFor >= SPEECH_END_SILENCE_MS || speakingFor >= MAX_UTTERANCE_MS) {
        // Confirmed utterance boundary: capture whatever voiced audio the
        // current segment still holds, then join all segment transcripts.
        userSpeaking = false;
        speculated = false;
        if (streamingUtterance) {
          finishStreamingUtterance();
        } else {
          if (segmentHasVoice) captureSegment();
          finishUtterance();
        }
      } else if (!streamingUtterance && !speculated && segmentHasVoice && silenceFor >= SPECULATIVE_SILENCE_MS) {
        // Early pause: start transcribing now; the boundary above still
        // decides whether the utterance actually ended.
        speculated = true;
        captureSegment();
      }
    } else if (now - lastBoundaryAt >= IDLE_RECYCLE_MS) {
      stopRecorder(null); // just silence in the buffer → discard
    }
  };

  const stop = ({ reason = "stopped" } = {}) => {
    if (!running && !mediaStream) return;
    running = false;
    window.clearInterval(vadTimer);
    vadTimer = 0;
    userSpeaking = false;
    speculated = false;
    voicedFrames = 0;
    pendingSegments = [];
    teardownStt();
    if (recorder && recorder.state !== "inactive") {
      segmentConsumer = null;
      try { recorder.stop(); } catch { /* already stopping */ }
    }
    recorder = null;
    sourceNode?.disconnect();
    sourceNode = null;
    analyser = null;
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    const context = audioContext;
    audioContext = null;
    context?.close().catch(() => {});
    setState("idle");
    onEnd(reason);
  };

  const start = async () => {
    if (running) return true;
    if (!isDuplexSupported()) {
      throw new ArcanaDuplexUnavailableError("Duplex audio is not supported in this browser.");
    }
    mimeType = pickRecordingMimeType() || "";

    running = true;
    setState("connecting");
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!running) {
        // stop() ran while the permission prompt was open: it saw no stream
        // yet, so this one must be released here or the mic stays live.
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
        return false;
      }

      audioContext = new AudioContext();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      sourceNode = audioContext.createMediaStreamSource(mediaStream);
      sourceNode.connect(analyser);

      lastBoundaryAt = performance.now();
      lastVoiceAt = 0;
      startRecorder();
      vadTimer = window.setInterval(vadTick, VAD_TICK_MS);
      // Dial the streaming STT socket in the background; until it reports
      // ready every utterance takes the batch path unchanged.
      void startStreamingStt();
      // Fire-and-forget cold-start warmup for the transcription path.
      fetch(transcribeEndpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "audio/wav" },
        body: buildSilentWav(),
      }).catch(() => {});
      setState("listening");
      return true;
    } catch (error) {
      stop({ reason: "error" });
      throw new ArcanaDuplexUnavailableError(
        error?.name === "NotAllowedError"
          ? "Microphone permission was denied."
          : "The microphone couldn't be started.",
      );
    }
  };

  return {
    start,
    stop,
    isRunning: () => running,
  };
}
