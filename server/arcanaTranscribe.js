export const ARCANA_TRANSCRIBE_PATH = "/api/arcana/transcribe";
export const TRANSCRIBE_AUDIO_LIMIT_BYTES = 8 * 1024 * 1024;
// Batch fallback transcription goes through OpenRouter's OpenAI-compatible
// endpoint; model names are OpenRouter-style (vendor-prefixed).
// Benchmarked 2026-08-18 over OpenRouter (2 s clip, warm): whisper-1 ~2.5 s,
// gpt-4o-mini-transcribe ~0.6 s with the broadest language coverage (incl.
// Chinese, unlike parakeet). Latency sits on the duplex critical path.
export const DEFAULT_TRANSCRIBE_MODEL = "openai/gpt-4o-mini-transcribe";
const OPENROUTER_TRANSCRIPTIONS_URL = "https://openrouter.ai/api/v1/audio/transcriptions";

export class ArcanaTranscribeError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "ArcanaTranscribeError";
    this.status = status;
  }
}

const SUPPORTED_AUDIO_TYPES = Object.freeze({
  "audio/webm": "question.webm",
  "audio/ogg": "question.ogg",
  "audio/mp4": "question.m4a",
  "audio/mpeg": "question.mp3",
  "audio/wav": "question.wav",
});

export function resolveTranscribeAudioType(contentType) {
  const baseType = String(contentType || "").split(";")[0].trim().toLowerCase();
  const filename = SUPPORTED_AUDIO_TYPES[baseType];
  return filename ? { baseType, filename } : null;
}

export async function transcribeArcanaAudio({
  audio,
  contentType,
  apiKey,
  model = DEFAULT_TRANSCRIBE_MODEL,
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey) throw new ArcanaTranscribeError("Voice transcription is not configured.", 503);

  const resolved = resolveTranscribeAudioType(contentType);
  if (!resolved) throw new ArcanaTranscribeError("Unsupported audio format.", 415);

  const byteLength = audio?.byteLength ?? 0;
  if (!byteLength) throw new ArcanaTranscribeError("An audio recording is required.", 400);
  if (byteLength > TRANSCRIBE_AUDIO_LIMIT_BYTES) throw new ArcanaTranscribeError("The recording is too long.", 413);

  const form = new FormData();
  form.append("file", new File([audio], resolved.filename, { type: resolved.baseType }));
  form.append("model", model);

  const response = await fetchImpl(OPENROUTER_TRANSCRIPTIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "X-Title": "Living Arcana" },
    body: form,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.warn(`[Living Arcana] OpenRouter transcription failed (${response.status}, model=${model}):`, body.slice(0, 400));
    throw new ArcanaTranscribeError(`Transcription request failed (${response.status}).`, 502);
  }

  const payload = await response.json();
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  return { text };
}
