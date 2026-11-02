import { getCardById } from "../src/data/tarot.js";

export const ARCANA_SPEAK_PATH = "/api/arcana/speak";

export class ArcanaSpeechError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "ArcanaSpeechError";
    this.status = status;
  }
}

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
}

export function parseVoiceMap(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function validateArcanaSpeech(payload, { voiceMap = {}, allowVoiceOverride = false } = {}) {
  const card = getCardById(payload?.cardId);
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  const configuredVoiceId = voiceMap[card?.id] || card?.tts?.voiceId || "";
  const requestedVoiceId = allowVoiceOverride && typeof payload?.voiceId === "string" ? payload.voiceId.trim() : "";
  const voiceId = requestedVoiceId || configuredVoiceId;

  if (!card) return { error: "Unknown Major Arcana card.", status: 400 };
  if (!text) return { error: "Speech text is required.", status: 400 };
  if (text.length > 1600) return { error: "Speech text is too long.", status: 400 };
  if (!voiceId) return { error: `No TTS voice is configured for ${card.name}.`, status: 503 };
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(voiceId)) return { error: "The TTS voice ID is invalid.", status: 400 };

  const defaults = card.tts;
  const requestedSettings = payload?.voiceSettings || {};
  return {
    card,
    text,
    voiceId,
    voiceSettings: {
      stability: clamp(requestedSettings.stability, 0, 1, defaults.stability),
      similarity_boost: clamp(requestedSettings.similarityBoost, 0, 1, defaults.similarityBoost),
      style: clamp(requestedSettings.style, 0, 1, defaults.style),
      speed: clamp(requestedSettings.speed, 0.7, 1.2, defaults.speed),
      use_speaker_boost: true,
    },
  };
}

export async function synthesizeArcanaSpeech({
  text,
  voiceId,
  voiceSettings,
  apiKey,
  model = "eleven_flash_v2_5",
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey) throw new ArcanaSpeechError("Real-time TTS is not configured.", 503);

  const endpoint = new URL(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`);
  endpoint.searchParams.set("output_format", "pcm_16000");
  // Trade a little text-normalization quality for a faster first audio chunk.
  endpoint.searchParams.set("optimize_streaming_latency", "4");
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Accept: "audio/pcm",
      "Content-Type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: model,
      voice_settings: voiceSettings,
    }),
  });

  if (!response.ok || !response.body) {
    throw new ArcanaSpeechError(`TTS provider request failed (${response.status}).`, 502);
  }
  return response;
}
