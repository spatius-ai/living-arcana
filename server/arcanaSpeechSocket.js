import { parseVoiceMap, validateArcanaSpeech } from "./arcanaSpeech.js";

export const ARCANA_SPEAK_SOCKET_PATH = "/api/arcana/speak-socket";

/**
 * WebSocket streaming TTS relay.
 *
 * One client connection = one utterance = one ElevenLabs `stream-input`
 * generation. The browser cannot attach the API key to a WebSocket handshake,
 * so this same-origin relay validates the init payload, dials ElevenLabs with
 * the server-side key, forwards text chunks upstream and streams the decoded
 * PCM back down as binary frames.
 *
 * Client -> relay (JSON strings):
 *   { type: "init", cardId, voiceId?, voiceSettings? }   first message
 *   { type: "text", text: "..." }                        one sentence/chunk
 *   { type: "end" }                                      no more text
 * Relay -> client:
 *   binary frame                                         PCM s16le 16k mono
 *   { type: "final" }                                    generation finished
 *   { type: "error", error, status }                     then the socket closes
 */

// Validate the init payload by reusing the /speak validator; the placeholder
// text only satisfies its non-empty check and is never synthesized.
export function validateSpeechSocketInit(payload, { voiceMap = {}, allowVoiceOverride = false } = {}) {
  if (payload?.type !== "init") return { error: "The first socket message must be an init payload.", status: 400 };
  const validated = validateArcanaSpeech({ ...payload, text: "ok" }, { voiceMap, allowVoiceOverride });
  if (validated.error) return validated;
  return { card: validated.card, voiceId: validated.voiceId, voiceSettings: validated.voiceSettings };
}

export function buildSpeechSocketUpstreamUrl({ voiceId, model = "eleven_flash_v2_5", protocol = "wss" }) {
  const endpoint = new URL(`${protocol}://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input`);
  endpoint.searchParams.set("model_id", model);
  endpoint.searchParams.set("output_format", "pcm_16000");
  // Synthesize as soon as text arrives (we always send complete sentences)
  // instead of waiting for the default chunk schedule to fill.
  endpoint.searchParams.set("auto_mode", "true");
  // Same trade as the HTTP /speak path: a little text-normalization quality
  // for a faster first audio chunk.
  endpoint.searchParams.set("optimize_streaming_latency", "4");
  endpoint.searchParams.set("inactivity_timeout", "60");
  return endpoint.toString();
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
  // Some transports reject close codes they consider reserved; never throw.
  try { socket.close(code); } catch { try { socket.close(); } catch { /* already closed */ } }
}

/**
 * Owns a freshly accepted client socket for its whole lifetime.
 *
 * `connectUpstream(url)` is the only platform-specific piece: it must resolve
 * to an open, message-ready WebSocket-like object (addEventListener / send /
 * close) for the given wss:// URL.
 */
export function createSpeechSocketSession({
  clientSocket,
  connectUpstream,
  apiKey,
  model = "eleven_flash_v2_5",
  voiceMap = {},
  allowVoiceOverride = false,
  ttsProvider = "elevenlabs",
}) {
  let upstream = null;
  let closed = false;
  let initialized = false;
  const queuedText = [];
  let queuedEnd = false;

  const fail = (error, status = 502) => {
    if (closed) return;
    closed = true;
    safeSend(clientSocket, JSON.stringify({ type: "error", error, status }));
    if (upstream) safeClose(upstream);
    safeClose(clientSocket, 1011);
  };

  const finish = () => {
    if (closed) return;
    closed = true;
    safeSend(clientSocket, JSON.stringify({ type: "final" }));
    if (upstream) safeClose(upstream);
    safeClose(clientSocket, 1000);
  };

  const sendUpstreamText = (text) => {
    safeSend(upstream, JSON.stringify({ text: `${text} ` }));
  };

  const attachUpstream = (socket, voiceSettings) => {
    upstream = socket;
    safeSend(upstream, JSON.stringify({ text: " ", voice_settings: voiceSettings, xi_api_key: apiKey }));
    while (queuedText.length) sendUpstreamText(queuedText.shift());
    if (queuedEnd) safeSend(upstream, JSON.stringify({ text: "" }));

    upstream.addEventListener("message", (event) => {
      if (closed) return;
      let payload;
      try {
        payload = JSON.parse(toText(event.data));
      } catch {
        return;
      }
      if (payload?.audio) safeSend(clientSocket, decodeBase64(payload.audio));
      if (payload?.isFinal) finish();
    });
    upstream.addEventListener("close", () => {
      // Upstream closing without an isFinal message still ends the utterance:
      // the client treats "final" as clean drain either way.
      finish();
    });
    upstream.addEventListener("error", () => {
      fail("The TTS stream failed.", 502);
    });
  };

  const handleInit = async (payload) => {
    initialized = true;
    if (ttsProvider !== "elevenlabs") {
      fail("Unsupported TTS provider.", 503);
      return;
    }
    if (!apiKey) {
      fail("Real-time TTS is not configured.", 503);
      return;
    }
    const validated = validateSpeechSocketInit(payload, { voiceMap, allowVoiceOverride });
    if (validated.error) {
      fail(validated.error, validated.status);
      return;
    }
    try {
      const socket = await connectUpstream(buildSpeechSocketUpstreamUrl({ voiceId: validated.voiceId, model }));
      if (closed) {
        safeClose(socket);
        return;
      }
      attachUpstream(socket, validated.voiceSettings);
    } catch {
      fail("The TTS stream could not be opened.", 502);
    }
  };

  clientSocket.addEventListener("message", (event) => {
    if (closed) return;
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
    if (payload?.type === "text") {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) return;
      if (text.length > 1600) {
        fail("Speech text is too long.", 400);
        return;
      }
      if (upstream) sendUpstreamText(text);
      else queuedText.push(text);
      return;
    }
    if (payload?.type === "end") {
      if (upstream) safeSend(upstream, JSON.stringify({ text: "" }));
      else queuedEnd = true;
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

export { parseVoiceMap };
