import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerArcanaQuestion,
  ARCANA_PROMPT_VERSION,
  streamArcanaAnswer,
  validateArcanaQuestion,
} from "../server/arcanaReading.js";
import { getArcanaCardStory } from "../server/arcanaCardStory.js";
import { getCardById, TAROT_CARDS } from "../src/data/tarot.js";

const card = getCardById("major-00-fool");

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("validateArcanaQuestion", () => {
  it("accepts a trimmed question and coerces the voice flag", () => {
    const result = validateArcanaQuestion({ cardId: card.id, question: "  What now?  ", voice: true });
    expect(result).toEqual({ card, question: "What now?", voice: true });
    expect(validateArcanaQuestion({ cardId: card.id, question: "ok?", voice: "true" }).voice).toBe(false);
  });

  it("rejects unknown cards, empty and oversized questions", () => {
    expect(validateArcanaQuestion({ cardId: "nope", question: "hi" }).error).toBe("Unknown Major Arcana card.");
    expect(validateArcanaQuestion({ cardId: card.id, question: "   " }).error).toBe("A question is required.");
    expect(validateArcanaQuestion({ cardId: card.id, question: "x".repeat(321) }).error).toBe("The question is too long.");
    expect(validateArcanaQuestion({ cardId: card.id, question: "x".repeat(320) }).error).toBeUndefined();
  });

  it("validates structured three-card context without mixing it into the user question", () => {
    expect(validateArcanaQuestion({
      cardId: card.id,
      question: "Does my ex still love me?",
      readingContext: {
        mode: "three-card-initial",
        originalQuestion: "  Does my ex still love me?  ",
        position: "signal",
        consultationId: "consultation-123",
      },
    })).toEqual({
      card,
      question: "Does my ex still love me?",
      voice: false,
      readingContext: {
        mode: "three-card-initial",
        originalQuestion: "Does my ex still love me?",
        position: "signal",
        consultationId: "consultation-123",
      },
    });

    expect(validateArcanaQuestion({
      cardId: card.id,
      question: "hello",
      readingContext: { mode: "three-card-initial", originalQuestion: "hello", position: "future", consultationId: "consultation-123" },
    }).error).toBe("The three-card reading context is invalid.");
  });

  it("validates a bounded, alternating daily-card history and turn ID", () => {
    expect(validateArcanaQuestion({
      cardId: card.id,
      question: "What should I do next?",
      dailyTurnId: "daily-turn-123",
      history: [
        { role: "user", content: "I keep delaying." },
        { role: "assistant", content: "I see you waiting at the edge of the path." },
      ],
    })).toMatchObject({
      dailyTurnId: "daily-turn-123",
      history: [
        { role: "user", content: "I keep delaying." },
        { role: "assistant", content: "I see you waiting at the edge of the path." },
      ],
    });

    expect(validateArcanaQuestion({
      cardId: card.id,
      question: "hello",
      dailyTurnId: "short",
    }).error).toBe("The daily card turn ID is invalid.");
    expect(validateArcanaQuestion({
      cardId: card.id,
      question: "hello",
      history: [{ role: "assistant", content: "out of order" }],
    }).error).toBe("The daily card history is invalid.");
  });
});

describe("embodied card story context", () => {
  it("covers every Major Arcana character with a persona and scene", () => {
    for (const tarotCard of TAROT_CARDS) {
      const story = getArcanaCardStory(tarotCard.id);
      expect(story?.avatar?.persona).toBeTruthy();
      expect(story?.avatar?.environment).toBeTruthy();
      expect(story?.avatar?.motion_cue).toBeTruthy();
    }
  });
});

describe("answerArcanaQuestion", () => {
  it("returns the curated fallback without an API key", async () => {
    const result = await answerArcanaQuestion({ card, question: "hello" });
    expect(result.source).toBe("curated");
    expect(result.cardId).toBe(card.id);
    expect(result.promptVersion).toBe(ARCANA_PROMPT_VERSION);
    expect(result.answer.length).toBeGreaterThan(0);
  });

  it("returns the LLM answer and shapes the upstream request", async () => {
    let requestBody;
    const fetchImpl = vi.fn(async (url, init) => {
      requestBody = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: "  Step lightly.  " } }] });
    });

    const result = await answerArcanaQuestion({ card, question: "hello", apiKey: "sk-test", model: "openai/test-model", fetchImpl });
    expect(result).toEqual({ answer: "Step lightly.", cardId: card.id, source: "llm", promptVersion: ARCANA_PROMPT_VERSION });
    expect(requestBody.model).toBe("openai/test-model");
    expect(requestBody.max_tokens).toBe(260);
    expect(requestBody.provider).toEqual({ sort: "latency" });
    expect(requestBody.messages[0].content).not.toContain("Live voice conversation");
    expect(requestBody.messages[0].content).toContain("not a neutral assistant");
    expect(requestBody.messages[0].content).toContain("Light Traveler");
    expect(requestBody.messages[0].content).toContain("Take an interpretive position");
  });

  it("places completed daily-card turns before the current question", async () => {
    let requestBody;
    const fetchImpl = vi.fn(async (url, init) => {
      requestBody = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: "Take the smaller first step." } }] });
    });

    await answerArcanaQuestion({
      card,
      question: "And what does that look like today?",
      history: [
        { role: "user", content: "I am afraid to start." },
        { role: "assistant", content: "I see you pausing at the edge." },
      ],
      apiKey: "sk-test",
      fetchImpl,
    });

    expect(requestBody.messages.slice(1)).toEqual([
      { role: "user", content: "I am afraid to start." },
      { role: "assistant", content: "I see you pausing at the edge." },
      { role: "user", content: "And what does that look like today?" },
    ]);
  });

  it("uses a position-specific three-card prompt with explicit human pronoun ownership", async () => {
    let requestBody;
    const fetchImpl = vi.fn(async (url, init) => {
      requestBody = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: "Strength suggests the bond still carries emotional weight. Watch whether their actions meet you with consistency." } }] });
    });

    await answerArcanaQuestion({
      card,
      question: "Does my ex still love me?",
      readingContext: {
        mode: "three-card-initial",
        originalQuestion: "Does my ex still love me?",
        position: "signal",
        consultationId: "consultation-123",
      },
      apiKey: "sk-test",
      fetchImpl,
    });

    expect(requestBody.messages[0].content).toContain("Signal — what wants the user's attention");
    expect(requestBody.messages[0].content).toContain("All first-person pronouns and possessives");
    expect(requestBody.messages[0].content).toContain("Never convert the user's ex");
    expect(requestBody.messages[0].content).toContain("Do not open with a disclaimer");
    expect(requestBody.messages[0].content).toContain("Use plain prose only");
    expect(requestBody.messages[0].content).not.toContain("Does my ex still love me?");
    expect(requestBody.messages[1]).toEqual({ role: "user", content: "Does my ex still love me?" });
  });

  it("switches to the short spoken prompt for voice turns", async () => {
    let requestBody;
    const fetchImpl = vi.fn(async (url, init) => {
      requestBody = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: "Yes." } }] });
    });

    await answerArcanaQuestion({ card, question: "hello", voice: true, apiKey: "sk-test", fetchImpl });
    expect(requestBody.max_tokens).toBe(160);
    expect(requestBody.messages[0].content).toContain("Live voice conversation");
  });

  it("joins content-part arrays from providers that return them", async () => {
    const fetchImpl = async () => Response.json({
      choices: [{ message: { content: [{ text: "Two " }, { type: "noise" }, { text: "halves." }] } }],
    });
    const result = await answerArcanaQuestion({ card, question: "hello", apiKey: "sk-test", fetchImpl });
    expect(result.answer).toBe("Two halves.");
    expect(result.source).toBe("llm");
  });

  it("falls back when the upstream fails, returns no text, or throws", async () => {
    const failing = async () => new Response("nope", { status: 500 });
    expect((await answerArcanaQuestion({ card, question: "hi", apiKey: "sk", fetchImpl: failing })).source).toBe("curated");

    const empty = async () => Response.json({ choices: [{ message: { content: "   " } }] });
    expect((await answerArcanaQuestion({ card, question: "hi", apiKey: "sk", fetchImpl: empty })).source).toBe("curated");

    const throwing = async () => { throw new Error("boom"); };
    expect((await answerArcanaQuestion({ card, question: "hi", apiKey: "sk", fetchImpl: throwing })).source).toBe("curated");
  });
});

describe("streamArcanaAnswer", () => {
  it("returns a curated JSON payload without an API key", async () => {
    const result = await streamArcanaAnswer({ card, question: "hello" });
    expect(result.type).toBe("json");
    expect(result.payload.source).toBe("curated");
  });

  it("passes the upstream SSE body through and requests streaming", async () => {
    let requestBody;
    const upstream = new Response("data: {}\n\n");
    const fetchImpl = vi.fn(async (url, init) => {
      requestBody = JSON.parse(init.body);
      return upstream;
    });

    const result = await streamArcanaAnswer({ card, question: "hello", apiKey: "sk-test", fetchImpl });
    expect(result.type).toBe("stream");
    expect(result.body).toBe(upstream.body);
    expect(requestBody.stream).toBe(true);
  });

  it("keeps original and follow-up questions labeled as user data", async () => {
    let requestBody;
    const upstream = new Response("data: {}\n\n");
    const fetchImpl = vi.fn(async (url, init) => {
      requestBody = JSON.parse(init.body);
      return upstream;
    });

    await streamArcanaAnswer({
      card,
      question: "How can I meet this with courage?",
      readingContext: {
        mode: "three-card-followup",
        originalQuestion: "Does my ex still love me?",
        position: "signal",
        consultationId: "consultation-123",
      },
      apiKey: "sk-test",
      fetchImpl,
    });

    expect(requestBody.messages[0].content).toContain("Answer the human user's current follow-up");
    expect(requestBody.messages[0].content).not.toContain("Does my ex still love me?");
    expect(requestBody.messages[1].content).toBe(
      "ORIGINAL USER QUESTION:\nDoes my ex still love me?\n\nCURRENT USER FOLLOW-UP:\nHow can I meet this with courage?",
    );
  });

  it("degrades to the curated payload on upstream failure", async () => {
    const failing = async () => new Response("nope", { status: 502 });
    expect((await streamArcanaAnswer({ card, question: "hi", apiKey: "sk", fetchImpl: failing })).type).toBe("json");

    const throwing = async () => { throw new Error("boom"); };
    expect((await streamArcanaAnswer({ card, question: "hi", apiKey: "sk", fetchImpl: throwing })).type).toBe("json");
  });
});
