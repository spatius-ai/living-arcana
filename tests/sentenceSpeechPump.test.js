import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSentenceSpeechPump } from "../src/duplex/sentenceSpeechPump.js";

class FakeWebSocket extends EventTarget {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    if (this.closed) throw new Error("send after close");
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  fireOpen() { this.dispatchEvent(new Event("open")); }
  fireMessage(data) { this.dispatchEvent(Object.assign(new Event("message"), { data })); }
  fireClose() { this.dispatchEvent(new Event("close")); }
  fireError() { this.dispatchEvent(new Event("error")); }
}

function collectSpatius() {
  const calls = [];
  return {
    calls,
    spatius: {
      streamPcm({ chunk, last }) {
        calls.push({ bytes: chunk ? new Uint8Array(chunk).slice() : null, last: Boolean(last) });
      },
    },
  };
}

const jsonSent = (socket) => socket.sent.map((frame) => JSON.parse(frame));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("window", { location: { protocol: "https:", host: "arcana.test" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSentenceSpeechPump (socket transport)", () => {
  it("streams sentences over one socket and ends with a single last frame", async () => {
    const { calls, spatius } = collectSpatius();
    const pump = createSentenceSpeechPump({ spatius, cardId: "major-00-fool", voiceId: "voice1234567" });
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe("wss://arcana.test/api/arcana/speak-socket");

    pump.enqueue("Queued before open.");
    expect(socket.sent).toEqual([]);

    socket.fireOpen();
    pump.enqueue("Sent after open.");
    pump.finish();
    expect(jsonSent(socket)).toEqual([
      { type: "init", cardId: "major-00-fool", voiceId: "voice1234567" },
      { type: "text", text: "Queued before open." },
      { type: "text", text: "Sent after open." },
      { type: "end" },
    ]);

    const pcm = new Uint8Array([1, 2, 3]).buffer;
    socket.fireMessage(pcm);
    socket.fireMessage(JSON.stringify({ type: "final" }));
    await pump.done;

    expect(calls).toEqual([
      { bytes: new Uint8Array([1, 2, 3]), last: false },
      { bytes: new Uint8Array(0), last: true },
    ]);
  });

  it("ends cleanly when the socket closes mid-stream after audio started", async () => {
    const { calls, spatius } = collectSpatius();
    const pump = createSentenceSpeechPump({ spatius, cardId: "major-00-fool" });
    const socket = FakeWebSocket.instances[0];
    socket.fireOpen();
    pump.enqueue("Hello.");
    socket.fireMessage(new Uint8Array([9, 9]).buffer);
    socket.fireClose();
    await pump.done;
    expect(calls.at(-1).last).toBe(true);
  });

  it("aborts hard: closes the socket, ignores late audio, never sends last", async () => {
    const { calls, spatius } = collectSpatius();
    const pump = createSentenceSpeechPump({ spatius, cardId: "major-00-fool" });
    const socket = FakeWebSocket.instances[0];
    socket.fireOpen();
    pump.enqueue("To be interrupted.");
    socket.fireMessage(new Uint8Array([1, 1]).buffer);

    pump.abort();
    expect(socket.closed).toBe(true);
    socket.fireMessage(new Uint8Array([2, 2]).buffer);
    await pump.done;

    expect(calls).toEqual([{ bytes: new Uint8Array([1, 1]), last: false }]);
  });
});

describe("createSentenceSpeechPump (HTTP fallback)", () => {
  it("replays buffered sentences per-sentence when the socket dies before audio", async () => {
    const { calls, spatius } = collectSpatius();
    const bodies = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init) => {
      bodies.push(JSON.parse(init.body));
      const index = bodies.length;
      return new Response(new Uint8Array([index, index]));
    }));

    const pump = createSentenceSpeechPump({ spatius, cardId: "major-00-fool" });
    const socket = FakeWebSocket.instances[0];
    pump.enqueue("First.");
    pump.enqueue("Second.");
    socket.fireError();
    socket.fireClose();

    pump.enqueue("Third.");
    pump.finish();
    await pump.done;

    expect(bodies.map((body) => body.text)).toEqual(["First.", "Second.", "Third."]);
    expect(bodies.every((body) => body.cardId === "major-00-fool")).toBe(true);
    expect(calls.filter((call) => !call.last).map((call) => Array.from(call.bytes))).toEqual([[1, 1], [2, 2], [3, 3]]);
    expect(calls.filter((call) => call.last)).toHaveLength(1);
    expect(calls.at(-1).last).toBe(true);
  });

  it("skips failed sentences and still drains", async () => {
    const { calls, spatius } = collectSpatius();
    let attempt = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return new Response("no key", { status: 503 });
      return new Response(new Uint8Array([5, 5]));
    }));

    const pump = createSentenceSpeechPump({ spatius, cardId: "major-00-fool" });
    FakeWebSocket.instances[0].fireError();
    FakeWebSocket.instances[0].fireClose();
    await flush();
    pump.enqueue("Fails.");
    pump.enqueue("Speaks.");
    pump.finish();
    await pump.done;

    expect(calls.filter((call) => !call.last)).toHaveLength(1);
    expect(Array.from(calls[0].bytes)).toEqual([5, 5]);
  });

  it("uses HTTP outright when WebSocket is unavailable", async () => {
    vi.stubGlobal("WebSocket", undefined);
    const { calls, spatius } = collectSpatius();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([8, 8]))));

    const pump = createSentenceSpeechPump({ spatius, cardId: "major-00-fool" });
    pump.enqueue("Plain HTTP.");
    pump.finish();
    await pump.done;

    expect(calls.filter((call) => !call.last)).toHaveLength(1);
    expect(calls.at(-1).last).toBe(true);
  });
});
