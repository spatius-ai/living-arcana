import { describe, expect, it, vi } from "vitest";
import { findSentenceEnd, readArcanaAnswerResponse } from "../src/duplex/arcanaAnswerStream.js";

describe("readArcanaAnswerResponse", () => {
  it("publishes accumulated SSE text across arbitrary chunks", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Move "}}]}\n',
      '\ndata: {"choices":[{"delta":{"content":"gently."}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const response = new Response(new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
    const onText = vi.fn();

    await expect(readArcanaAnswerResponse(response, { onText })).resolves.toBe("Move gently.");
    expect(onText.mock.calls.map(([text]) => text)).toEqual(["Move ", "Move gently."]);
  });

  it("uses the JSON answer and falls back when a stream has no content", async () => {
    const json = new Response(JSON.stringify({ answer: "A clear answer." }), {
      headers: { "Content-Type": "application/json" },
    });
    await expect(readArcanaAnswerResponse(json, { fallbackAnswer: "Fallback." })).resolves.toBe("A clear answer.");

    const empty = new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    await expect(readArcanaAnswerResponse(empty, { fallbackAnswer: "Fallback." })).resolves.toBe("Fallback.");
  });
});

describe("findSentenceEnd", () => {
  it("lets only the first chunk stop at a clause boundary", () => {
    const text = "Begin softly, then take the next step.";
    expect(findSentenceEnd(text, 0, true)).toBe("Begin softly,".length);
    expect(findSentenceEnd(text, 0, false)).toBe(text.length);
  });
});
