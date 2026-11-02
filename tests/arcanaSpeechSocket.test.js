import { describe, expect, it } from "vitest";
import {
  buildSpeechSocketUpstreamUrl,
  createSpeechSocketSession,
  validateSpeechSocketInit,
} from "../server/arcanaSpeechSocket.js";
import { getCardById } from "../src/data/tarot.js";

const card = getCardById("major-00-fool");

class FakeSocket extends EventTarget {
  constructor() {
    super();
    this.sent = [];
    this.closed = false;
    this.closeCode = null;
  }

  send(data) {
    if (this.closed) throw new Error("send after close");
    this.sent.push(data);
  }

  close(code) {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code ?? 1005;
    this.dispatchEvent(new Event("close"));
  }

  emitMessage(data) {
    this.dispatchEvent(Object.assign(new Event("message"), { data }));
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function jsonFrames(socket) {
  return socket.sent.filter((frame) => typeof frame === "string").map((frame) => JSON.parse(frame));
}

function startSession(overrides = {}) {
  const client = new FakeSocket();
  const upstream = new FakeSocket();
  createSpeechSocketSession({
    clientSocket: client,
    apiKey: "el-test-key",
    model: "eleven_flash_v2_5",
    connectUpstream: async () => upstream,
    ...overrides,
  });
  return { client, upstream };
}

describe("validateSpeechSocketInit", () => {
  it("requires an init payload with a known card", () => {
    expect(validateSpeechSocketInit({ type: "text", text: "hi" })).toMatchObject({ status: 400 });
    expect(validateSpeechSocketInit({ type: "init", cardId: "nope" })).toMatchObject({ status: 400 });
    const valid = validateSpeechSocketInit({ type: "init", cardId: card.id });
    expect(valid.error).toBeUndefined();
    expect(valid.voiceId).toBe(card.tts.voiceId);
  });
});

describe("buildSpeechSocketUpstreamUrl", () => {
  it("targets stream-input with pcm output and auto mode", () => {
    const url = new URL(buildSpeechSocketUpstreamUrl({ voiceId: "voice123456", model: "eleven_flash_v2_5" }));
    expect(url.pathname).toBe("/v1/text-to-speech/voice123456/stream-input");
    expect(url.searchParams.get("output_format")).toBe("pcm_16000");
    expect(url.searchParams.get("auto_mode")).toBe("true");
    expect(url.searchParams.get("model_id")).toBe("eleven_flash_v2_5");
  });
});

describe("createSpeechSocketSession", () => {
  it("refuses to start without an API key", async () => {
    const { client } = startSession({ apiKey: "" });
    client.emitMessage(JSON.stringify({ type: "init", cardId: card.id }));
    await flush();
    expect(jsonFrames(client)).toEqual([{ type: "error", error: "Real-time TTS is not configured.", status: 503 }]);
    expect(client.closed).toBe(true);
  });

  it("rejects an invalid init and non-elevenlabs providers", async () => {
    const bad = startSession();
    bad.client.emitMessage(JSON.stringify({ type: "init", cardId: "nope" }));
    await flush();
    expect(jsonFrames(bad.client)[0]).toMatchObject({ type: "error", status: 400 });

    const provider = startSession({ ttsProvider: "other" });
    provider.client.emitMessage(JSON.stringify({ type: "init", cardId: card.id }));
    await flush();
    expect(jsonFrames(provider.client)[0]).toMatchObject({ type: "error", status: 503 });
  });

  it("relays text upstream and decoded audio downstream, in order", async () => {
    const { client, upstream } = startSession();
    client.emitMessage(JSON.stringify({ type: "init", cardId: card.id }));
    client.emitMessage(JSON.stringify({ type: "text", text: "First sentence." }));
    await flush();
    client.emitMessage(JSON.stringify({ type: "text", text: "Second sentence." }));
    client.emitMessage(JSON.stringify({ type: "end" }));
    await flush();

    const frames = jsonFrames(upstream);
    expect(frames[0].xi_api_key).toBe("el-test-key");
    expect(frames[0].voice_settings.use_speaker_boost).toBe(true);
    expect(frames.slice(1)).toEqual([
      { text: "First sentence. " },
      { text: "Second sentence. " },
      { text: "" },
    ]);

    const pcm = new Uint8Array([7, 8, 9, 250]);
    upstream.emitMessage(JSON.stringify({ audio: btoa(String.fromCharCode(...pcm)), isFinal: null }));
    const binary = client.sent.find((frame) => typeof frame !== "string");
    expect(new Uint8Array(binary.buffer ?? binary)).toEqual(pcm);

    upstream.emitMessage(JSON.stringify({ isFinal: true }));
    await flush();
    expect(jsonFrames(client)).toContainEqual({ type: "final" });
    expect(client.closed).toBe(true);
    expect(upstream.closed).toBe(true);
  });

  it("queues text sent while the upstream is still connecting", async () => {
    const upstream = new FakeSocket();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const client = new FakeSocket();
    createSpeechSocketSession({
      clientSocket: client,
      apiKey: "el-test-key",
      connectUpstream: async () => { await gate; return upstream; },
    });

    client.emitMessage(JSON.stringify({ type: "init", cardId: card.id }));
    client.emitMessage(JSON.stringify({ type: "text", text: "Queued while dialing." }));
    client.emitMessage(JSON.stringify({ type: "end" }));
    await flush();
    expect(upstream.sent).toEqual([]);

    release();
    await flush();
    expect(jsonFrames(upstream).slice(1)).toEqual([{ text: "Queued while dialing. " }, { text: "" }]);
  });

  it("treats an upstream close without isFinal as a clean finish", async () => {
    const { client, upstream } = startSession();
    client.emitMessage(JSON.stringify({ type: "init", cardId: card.id }));
    await flush();
    upstream.close();
    expect(jsonFrames(client)).toContainEqual({ type: "final" });
    expect(client.closed).toBe(true);
  });

  it("closes the upstream when the client goes away", async () => {
    const { client, upstream } = startSession();
    client.emitMessage(JSON.stringify({ type: "init", cardId: card.id }));
    await flush();
    client.close();
    expect(upstream.closed).toBe(true);
  });

  it("closes an upstream that finishes connecting after the client left", async () => {
    const upstream = new FakeSocket();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const client = new FakeSocket();
    createSpeechSocketSession({
      clientSocket: client,
      apiKey: "el-test-key",
      connectUpstream: async () => { await gate; return upstream; },
    });
    client.emitMessage(JSON.stringify({ type: "init", cardId: card.id }));
    client.close();
    release();
    await flush();
    expect(upstream.closed).toBe(true);
  });

  it("fails fast on malformed frames and oversized text", async () => {
    const malformed = startSession();
    malformed.client.emitMessage("not json");
    await flush();
    expect(jsonFrames(malformed.client)[0]).toMatchObject({ type: "error", status: 400 });

    const oversized = startSession();
    oversized.client.emitMessage(JSON.stringify({ type: "init", cardId: card.id }));
    await flush();
    oversized.client.emitMessage(JSON.stringify({ type: "text", text: "x".repeat(1601) }));
    await flush();
    expect(jsonFrames(oversized.client)).toContainEqual({ type: "error", error: "Speech text is too long.", status: 400 });
  });
});
