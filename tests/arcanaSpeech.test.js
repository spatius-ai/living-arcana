import { describe, expect, it } from "vitest";
import { parseVoiceMap, validateArcanaSpeech } from "../server/arcanaSpeech.js";
import { getCardById } from "../src/data/tarot.js";

const card = getCardById("major-00-fool");
const OTHER_VOICE = "abcdefgh12345678";

describe("parseVoiceMap", () => {
  it("parses JSON strings and passes objects through", () => {
    expect(parseVoiceMap(`{"${card.id}":"${OTHER_VOICE}"}`)).toEqual({ [card.id]: OTHER_VOICE });
    expect(parseVoiceMap({ a: "b" })).toEqual({ a: "b" });
  });

  it("returns an empty map for invalid input", () => {
    expect(parseVoiceMap("")).toEqual({});
    expect(parseVoiceMap("{broken")).toEqual({});
    expect(parseVoiceMap('"a string"')).toEqual({});
  });
});

describe("validateArcanaSpeech", () => {
  it("accepts card text and resolves the configured voice", () => {
    const result = validateArcanaSpeech({ cardId: card.id, text: "  Hello there.  " });
    expect(result.error).toBeUndefined();
    expect(result.card).toBe(card);
    expect(result.text).toBe("Hello there.");
    expect(result.voiceId).toBe(card.tts.voiceId);
    expect(result.voiceSettings.use_speaker_boost).toBe(true);
  });

  it("rejects unknown cards, empty and oversized text", () => {
    expect(validateArcanaSpeech({ cardId: "nope", text: "hi" })).toMatchObject({ status: 400 });
    expect(validateArcanaSpeech({ cardId: card.id, text: "   " })).toMatchObject({ status: 400 });
    expect(validateArcanaSpeech({ cardId: card.id, text: "x".repeat(1601) })).toMatchObject({ status: 400 });
  });

  it("prefers the deployment voice map over the card default", () => {
    const result = validateArcanaSpeech({ cardId: card.id, text: "hi" }, { voiceMap: { [card.id]: OTHER_VOICE } });
    expect(result.voiceId).toBe(OTHER_VOICE);
  });

  it("honors the requested voice only when overrides are allowed", () => {
    const ignored = validateArcanaSpeech({ cardId: card.id, text: "hi", voiceId: OTHER_VOICE });
    expect(ignored.voiceId).toBe(card.tts.voiceId);

    const allowed = validateArcanaSpeech(
      { cardId: card.id, text: "hi", voiceId: OTHER_VOICE },
      { allowVoiceOverride: true },
    );
    expect(allowed.voiceId).toBe(OTHER_VOICE);
  });

  it("rejects malformed voice ids", () => {
    const result = validateArcanaSpeech(
      { cardId: card.id, text: "hi", voiceId: "bad voice!" },
      { allowVoiceOverride: true },
    );
    expect(result).toMatchObject({ status: 400, error: "The TTS voice ID is invalid." });
  });

  it("clamps voice settings into their supported ranges", () => {
    const result = validateArcanaSpeech({
      cardId: card.id,
      text: "hi",
      voiceSettings: { stability: 9, similarityBoost: "not-a-number", style: -3, speed: 0.1 },
    });
    expect(result.voiceSettings.stability).toBe(1);
    expect(result.voiceSettings.similarity_boost).toBe(card.tts.similarityBoost);
    expect(result.voiceSettings.style).toBe(0);
    expect(result.voiceSettings.speed).toBe(0.7);
  });
});
