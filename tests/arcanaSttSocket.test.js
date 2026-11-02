import { describe, expect, it } from "vitest";
import {
  buildSttSocketUpstreamUrl,
  createSttSocketSession,
  validateSttSocketInit,
} from "../server/arcanaSttSocket.js";

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
  let upstreamRequest = null;
  createSttSocketSession({
    clientSocket: client,
    apiKey: "el-test-key",
    connectUpstream: async (url, options) => {
      upstreamRequest = { url, options };
      wireUpstream(upstream, options);
      return upstream;
    },
    ...overrides,
  });
  return { client, upstream, getUpstreamRequest: () => upstreamRequest };
}

// Mirrors what the dev/Worker connectUpstream implementations do: the
// session's handlers are attached to the raw socket at connection time.
function wireUpstream(upstream, options = {}) {
  upstream.addEventListener("message", (event) => options.onMessage?.(event.data));
  upstream.addEventListener("close", () => options.onClose?.());
  upstream.addEventListener("error", () => options.onError?.());
}

const init = (extra = {}) => JSON.stringify({ type: "init", sampleRate: 48000, ...extra });

describe("validateSttSocketInit", () => {
  it("requires an init payload with a supported sample rate", () => {
    expect(validateSttSocketInit({ type: "commit" })).toMatchObject({ status: 400 });
    expect(validateSttSocketInit({ type: "init", sampleRate: 12345 })).toMatchObject({ status: 400 });
    expect(validateSttSocketInit({ type: "init", sampleRate: 44100 })).toEqual({ sampleRate: 44100, language: undefined });
  });

  it("accepts only short ISO language codes", () => {
    expect(validateSttSocketInit({ type: "init", sampleRate: 16000, language: "ZH" })).toEqual({ sampleRate: 16000, language: "zh" });
    expect(validateSttSocketInit({ type: "init", sampleRate: 16000, language: "not-a-code" })).toMatchObject({ status: 400 });
  });
});

describe("buildSttSocketUpstreamUrl", () => {
  it("targets realtime scribe with manual commits and the client's rate", () => {
    const url = new URL(buildSttSocketUpstreamUrl({ sampleRate: 48000, language: "zh" }));
    expect(url.pathname).toBe("/v1/speech-to-text/realtime");
    expect(url.searchParams.get("model_id")).toBe("scribe_v2_realtime");
    expect(url.searchParams.get("audio_format")).toBe("pcm_48000");
    expect(url.searchParams.get("commit_strategy")).toBe("manual");
    expect(url.searchParams.get("language_code")).toBe("zh");
  });

  it("omits language_code unless one was given", () => {
    const url = new URL(buildSttSocketUpstreamUrl({ sampleRate: 16000 }));
    expect(url.searchParams.get("language_code")).toBeNull();
  });
});

describe("createSttSocketSession", () => {
  it("refuses to start without an API key", async () => {
    const { client } = startSession({ apiKey: "" });
    client.emitMessage(init());
    await flush();
    expect(jsonFrames(client)).toEqual([{ type: "error", error: "Real-time transcription is not configured.", status: 503 }]);
    expect(client.closed).toBe(true);
  });

  it("rejects an invalid init and audio before init", async () => {
    const bad = startSession();
    bad.client.emitMessage(init({ sampleRate: 12345 }));
    await flush();
    expect(jsonFrames(bad.client)[0]).toMatchObject({ type: "error", status: 400 });

    const early = startSession();
    early.client.emitMessage(new Uint8Array([1, 2]).buffer);
    await flush();
    expect(jsonFrames(early.client)[0]).toMatchObject({ type: "error", status: 400 });
  });

  it("dials upstream with the key in the handshake headers", async () => {
    const { client, getUpstreamRequest } = startSession();
    client.emitMessage(init());
    await flush();
    expect(getUpstreamRequest().options.headers["xi-api-key"]).toBe("el-test-key");
  });

  it("relays audio as base64 chunks and commits as flagged silence", async () => {
    const { client, upstream } = startSession();
    client.emitMessage(init());
    await flush();
    upstream.emitMessage(JSON.stringify({ message_type: "session_started", session_id: "s1" }));
    expect(jsonFrames(client)).toContainEqual({ type: "ready" });

    const pcm = new Uint8Array([1, 2, 3, 4]);
    client.emitMessage(pcm.buffer);
    client.emitMessage(JSON.stringify({ type: "commit" }));

    const frames = jsonFrames(upstream);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ message_type: "input_audio_chunk", commit: false, sample_rate: 48000 });
    expect(Buffer.from(frames[0].audio_base_64, "base64")).toEqual(Buffer.from(pcm));
    expect(frames[1]).toMatchObject({ message_type: "input_audio_chunk", commit: true, sample_rate: 48000 });
    // 20 ms of s16le silence at 48 kHz carries the commit flag.
    expect(Buffer.from(frames[1].audio_base_64, "base64").length).toBe(960 * 2);
  });

  it("queues audio and commits sent while the upstream is still dialing", async () => {
    const upstream = new FakeSocket();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const client = new FakeSocket();
    createSttSocketSession({
      clientSocket: client,
      apiKey: "el-test-key",
      connectUpstream: async () => { await gate; return upstream; },
    });

    client.emitMessage(init());
    client.emitMessage(new Uint8Array([9, 9]).buffer);
    client.emitMessage(JSON.stringify({ type: "commit" }));
    await flush();
    expect(upstream.sent).toEqual([]);

    release();
    await flush();
    const frames = jsonFrames(upstream);
    expect(frames.map((frame) => frame.commit)).toEqual([false, true]);
  });

  it("does not lose upstream messages that share the handshake tick", async () => {
    // Scribe can emit session_started (or auth_error) before the session's
    // await on connectUpstream resumes; handlers are attached at creation.
    const client = new FakeSocket();
    const upstream = new FakeSocket();
    createSttSocketSession({
      clientSocket: client,
      apiKey: "el-test-key",
      connectUpstream: async (url, options) => {
        wireUpstream(upstream, options);
        upstream.emitMessage(JSON.stringify({ message_type: "session_started" }));
        return upstream;
      },
    });
    client.emitMessage(init());
    await flush();
    expect(jsonFrames(client)).toContainEqual({ type: "ready" });
  });

  it("forwards partial and committed transcripts", async () => {
    const { client, upstream } = startSession();
    client.emitMessage(init());
    await flush();
    upstream.emitMessage(JSON.stringify({ message_type: "partial_transcript", text: "你好" }));
    upstream.emitMessage(JSON.stringify({ message_type: "committed_transcript", text: "你好世界" }));
    upstream.emitMessage(JSON.stringify({ message_type: "committed_transcript_with_timestamps", text: "again", words: [] }));
    expect(jsonFrames(client)).toEqual([
      { type: "partial", text: "你好" },
      { type: "committed", text: "你好世界" },
      { type: "committed", text: "again" },
    ]);
  });

  it("maps a commit over silence to an empty committed transcript", async () => {
    const { client, upstream } = startSession();
    client.emitMessage(init());
    await flush();
    upstream.emitMessage(JSON.stringify({ message_type: "insufficient_audio_activity", error: "no speech" }));
    expect(jsonFrames(client)).toEqual([{ type: "committed", text: "" }]);
    expect(client.closed).toBe(false);
  });

  it("fails the session on upstream errors and closes", async () => {
    const { client, upstream } = startSession();
    client.emitMessage(init());
    await flush();
    upstream.emitMessage(JSON.stringify({ message_type: "auth_error", error: "bad key" }));
    expect(jsonFrames(client)).toContainEqual({ type: "error", error: "bad key", status: 503, code: "auth_error" });
    expect(client.closed).toBe(true);
    expect(upstream.closed).toBe(true);
  });

  it("treats an unexpected upstream close as a failure the client can react to", async () => {
    const { client, upstream } = startSession();
    client.emitMessage(init());
    await flush();
    upstream.close();
    expect(jsonFrames(client)).toContainEqual({ type: "error", error: "The transcription stream closed.", status: 502, code: "upstream_closed" });
    expect(client.closed).toBe(true);
  });

  it("closes the upstream when the client goes away", async () => {
    const { client, upstream } = startSession();
    client.emitMessage(init());
    await flush();
    client.close();
    expect(upstream.closed).toBe(true);
  });

  it("closes an upstream that finishes connecting after the client left", async () => {
    const upstream = new FakeSocket();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const client = new FakeSocket();
    createSttSocketSession({
      clientSocket: client,
      apiKey: "el-test-key",
      connectUpstream: async () => { await gate; return upstream; },
    });
    client.emitMessage(init());
    client.close();
    release();
    await flush();
    expect(upstream.closed).toBe(true);
  });

  it("fails fast on malformed frames", async () => {
    const { client } = startSession();
    client.emitMessage("not json");
    await flush();
    expect(jsonFrames(client)[0]).toMatchObject({ type: "error", status: 400 });
  });
});
