import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveTranscribeAudioType,
  transcribeArcanaAudio,
  TRANSCRIBE_AUDIO_LIMIT_BYTES,
} from "../server/arcanaTranscribe.js";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const audio = new Uint8Array([1, 2, 3, 4]);

async function expectStatus(promise, status) {
  await expect(promise).rejects.toMatchObject({ status });
}

describe("resolveTranscribeAudioType", () => {
  it("accepts the supported formats, with codec parameters", () => {
    expect(resolveTranscribeAudioType("audio/webm")).toEqual({ baseType: "audio/webm", filename: "question.webm" });
    expect(resolveTranscribeAudioType("audio/webm;codecs=opus").baseType).toBe("audio/webm");
    expect(resolveTranscribeAudioType(" AUDIO/WAV ").filename).toBe("question.wav");
    expect(resolveTranscribeAudioType("audio/mp4").filename).toBe("question.m4a");
  });

  it("rejects everything else", () => {
    expect(resolveTranscribeAudioType("text/plain")).toBeNull();
    expect(resolveTranscribeAudioType("audio/flac")).toBeNull();
    expect(resolveTranscribeAudioType(undefined)).toBeNull();
  });
});

describe("transcribeArcanaAudio", () => {
  it("maps each validation failure to its status code", async () => {
    await expectStatus(transcribeArcanaAudio({ audio, contentType: "audio/webm" }), 503);
    await expectStatus(transcribeArcanaAudio({ audio, contentType: "audio/flac", apiKey: "sk" }), 415);
    await expectStatus(transcribeArcanaAudio({ audio: new Uint8Array(0), contentType: "audio/webm", apiKey: "sk" }), 400);
    await expectStatus(
      transcribeArcanaAudio({
        audio: { byteLength: TRANSCRIBE_AUDIO_LIMIT_BYTES + 1 },
        contentType: "audio/webm",
        apiKey: "sk",
      }),
      413,
    );
  });

  it("posts multipart audio and returns the trimmed text", async () => {
    let captured;
    const fetchImpl = vi.fn(async (url, init) => {
      captured = init;
      return Response.json({ text: "  What should I do today?  " });
    });

    const result = await transcribeArcanaAudio({ audio, contentType: "audio/webm;codecs=opus", apiKey: "sk", model: "openai/test-stt", fetchImpl });
    expect(result).toEqual({ text: "What should I do today?" });
    expect(captured.headers.Authorization).toBe("Bearer sk");
    const file = captured.body.get("file");
    expect(file.name).toBe("question.webm");
    expect(captured.body.get("model")).toBe("openai/test-stt");
  });

  it("wraps upstream failures as 502", async () => {
    const fetchImpl = async () => new Response("boom", { status: 500 });
    await expectStatus(transcribeArcanaAudio({ audio, contentType: "audio/webm", apiKey: "sk", fetchImpl }), 502);
  });
});
