export const ARCANA_STT_SOCKET_PATH = "/api/arcana/stt-socket";
export const DEFAULT_REALTIME_STT_MODEL = "scribe_v2_realtime";

/**
 * WebSocket streaming STT relay (mirror of arcanaSpeechSocket.js).
 *
 * One client connection = one duplex conversation. The browser streams raw
 * mic PCM only while the local VAD hears speech; the relay wraps it into
 * ElevenLabs realtime Scribe `input_audio_chunk` messages (manual commit
 * strategy — the browser VAD stays the authority on utterance boundaries).
 * The browser cannot attach the API key to a WebSocket handshake, so this
 * same-origin relay dials ElevenLabs with the server-side key.
 *
 * Client -> relay:
 *   { type: "init", sampleRate, language? }   first message (JSON)
 *   binary frame                              PCM s16le mono at sampleRate
 *   { type: "commit" }                        utterance boundary
 * Relay -> client:
 *   { type: "ready" }                         upstream session accepted audio
 *   { type: "partial", text }                 live transcript of the segment
 *   { type: "committed", text }               transcript for one commit
 *   { type: "error", error, status, code? }   then the socket closes
 */

// ElevenLabs realtime `audio_format` values (pcm_<rate>); the client sends
// its AudioContext's native rate so no resampling happens on either side.
const SUPPORTED_STT_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000];
// Audio queued while the upstream is still dialing; beyond this we drop the
// oldest frames instead of growing without bound.
const MAX_QUEUED_AUDIO_BYTES = 2 * 1024 * 1024;

export function validateSttSocketInit(payload) {
  if (payload?.type !== "init") return { error: "The first socket message must be an init payload.", status: 400 };
  const sampleRate = Number(payload.sampleRate);
  if (!SUPPORTED_STT_SAMPLE_RATES.includes(sampleRate)) {
    return { error: "Unsupported audio sample rate.", status: 400 };
  }
  let language;
  if (payload.language != null && payload.language !== "") {
    language = String(payload.language).trim().toLowerCase();
    if (!/^[a-z]{2,3}$/.test(language)) return { error: "Unsupported language code.", status: 400 };
  }
  return { sampleRate, language };
}

export function buildSttSocketUpstreamUrl({
  model = DEFAULT_REALTIME_STT_MODEL,
  sampleRate,
  language,
  protocol = "wss",
}) {
  const endpoint = new URL(`${protocol}://api.elevenlabs.io/v1/speech-to-text/realtime`);
  endpoint.searchParams.set("model_id", model);
  endpoint.searchParams.set("audio_format", `pcm_${sampleRate}`);
  // The browser VAD decides where utterances end; upstream VAD would race it.
  endpoint.searchParams.set("commit_strategy", "manual");
  if (language) endpoint.searchParams.set("language_code", language);
  return endpoint.toString();
}

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function encodeBase64(bytes) {
  if (typeof Buffer !== "undefined" && Buffer.from) return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function toText(data) {
  if (typeof data === "string") return data;
  try {
    return new TextDecoder().decode(data);
  } catch {
    return "";
  }
}

function safeSend(socket, data) {
  try { socket.send(data); } catch { /* the socket is already closing */ }
}

function safeClose(socket, code = 1000) {
  try { socket.close(code); } catch { try { socket.close(); } catch { /* already closed */ } }
}

const UPSTREAM_ERROR_STATUS = {
  auth_error: 503,
  quota_exceeded: 503,
  rate_limited: 429,
  input_error: 400,
  chunk_size_exceeded: 400,
};

/**
 * Owns a freshly accepted client socket for its whole lifetime.
 *
 * `connectUpstream(url, { headers, onMessage, onClose, onError })` is the
 * only platform-specific piece: it must resolve to an open WebSocket-like
 * object for the given wss:// URL with the extra handshake headers attached
 * (realtime Scribe authenticates via the `xi-api-key` header, unlike the TTS
 * stream-input socket's in-band key). The handlers MUST be attached at
 * socket creation, not after the promise resolves: Scribe sends
 * session_started (or auth_error) in the same I/O tick as the handshake, so
 * a listener attached in a `.then` is already too late.
 */
export function createSttSocketSession({
  clientSocket,
  connectUpstream,
  apiKey,
  model = DEFAULT_REALTIME_STT_MODEL,
}) {
  let upstream = null;
  let closed = false;
  let initialized = false;
  let sampleRate = 0;
  const queuedAudio = [];
  let queuedAudioBytes = 0;
  let queuedCommits = 0;

  const fail = (error, status = 502, code) => {
    if (closed) return;
    closed = true;
    safeSend(clientSocket, JSON.stringify({ type: "error", error, status, ...(code ? { code } : {}) }));
    if (upstream) safeClose(upstream);
    safeClose(clientSocket, 1011);
  };

  const sendAudioChunk = (bytes, commit) => {
    safeSend(upstream, JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: encodeBase64(bytes),
      commit,
      sample_rate: sampleRate,
    }));
  };

  // A commit rides on an audio chunk; 20 ms of silence carries the flag
  // without altering what was heard.
  const sendCommit = () => {
    sendAudioChunk(new Uint8Array(Math.round(sampleRate * 0.02) * 2), true);
  };

  const handleUpstreamMessage = (payload) => {
    const messageType = String(payload?.message_type || "").toLowerCase();
    if (!messageType) return;
    if (messageType.includes("session") && messageType.includes("started")) {
      safeSend(clientSocket, JSON.stringify({ type: "ready" }));
      return;
    }
    if (messageType === "partial_transcript" || messageType === "final_transcript") {
      safeSend(clientSocket, JSON.stringify({ type: "partial", text: String(payload.text ?? "") }));
      return;
    }
    if (messageType.startsWith("committed_transcript")) {
      // The *_with_timestamps / entity variants only add fields.
      safeSend(clientSocket, JSON.stringify({ type: "committed", text: String(payload.text ?? "") }));
      return;
    }
    if (messageType === "insufficient_audio_activity") {
      // A commit over near-silence is an empty utterance, not a failure.
      safeSend(clientSocket, JSON.stringify({ type: "committed", text: "" }));
      return;
    }
    if (messageType.includes("error") || messageType in UPSTREAM_ERROR_STATUS
      || ["quota_exceeded", "rate_limited", "session_time_limit_exceeded", "queue_overflow", "resource_exhausted"].includes(messageType)) {
      fail(String(payload?.error || "The transcription stream failed."), UPSTREAM_ERROR_STATUS[messageType] ?? 502, messageType);
    }
  };

  const handleInit = async (payload) => {
    initialized = true;
    if (!apiKey) {
      fail("Real-time transcription is not configured.", 503);
      return;
    }
    const validated = validateSttSocketInit(payload);
    if (validated.error) {
      fail(validated.error, validated.status);
      return;
    }
    sampleRate = validated.sampleRate;
    try {
      const socket = await connectUpstream(
        buildSttSocketUpstreamUrl({ model, sampleRate, language: validated.language }),
        {
          headers: { "xi-api-key": apiKey },
          onMessage: (data) => {
            if (closed) return;
            let upstreamPayload;
            try {
              upstreamPayload = JSON.parse(toText(data));
            } catch {
              return;
            }
            handleUpstreamMessage(upstreamPayload);
          },
          onClose: () => {
            // Realtime sessions are expected to outlive many utterances; an
            // upstream close mid-conversation is a failure the client can
            // react to (it falls back to batch transcription).
            fail("The transcription stream closed.", 502, "upstream_closed");
          },
          onError: () => {
            fail("The transcription stream failed.", 502);
          },
        },
      );
      if (closed) {
        safeClose(socket);
        return;
      }
      upstream = socket;
      while (queuedAudio.length) sendAudioChunk(queuedAudio.shift(), false);
      queuedAudioBytes = 0;
      while (queuedCommits > 0) {
        queuedCommits -= 1;
        sendCommit();
      }
    } catch {
      fail("The transcription stream could not be opened.", 502);
    }
  };

  clientSocket.addEventListener("message", (event) => {
    if (closed) return;
    const binary = typeof event.data === "string" ? null : toUint8(event.data);

    if (binary) {
      if (!initialized) {
        fail("The first socket message must be an init payload.", 400);
        return;
      }
      if (upstream) {
        sendAudioChunk(binary, false);
        return;
      }
      queuedAudio.push(binary);
      queuedAudioBytes += binary.byteLength;
      while (queuedAudioBytes > MAX_QUEUED_AUDIO_BYTES && queuedAudio.length) {
        queuedAudioBytes -= queuedAudio.shift().byteLength;
      }
      return;
    }

    let payload;
    try {
      payload = JSON.parse(toText(event.data));
    } catch {
      fail("Malformed socket message.", 400);
      return;
    }
    if (!initialized) {
      void handleInit(payload);
      return;
    }
    if (payload?.type === "commit") {
      if (upstream) sendCommit();
      else queuedCommits += 1;
    }
  });

  clientSocket.addEventListener("close", () => {
    if (closed) return;
    closed = true;
    if (upstream) safeClose(upstream);
  });
  clientSocket.addEventListener("error", () => {
    if (closed) return;
    closed = true;
    if (upstream) safeClose(upstream);
  });
}
