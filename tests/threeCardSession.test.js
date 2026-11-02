import { describe, expect, it } from "vitest";
import {
  clearThreeCardSession,
  hasRestorableThreeCardSession,
  readThreeCardSession,
  THREE_CARD_SESSION_KEY,
  writeThreeCardSession,
} from "../src/reading/threeCardSession.js";

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

const session = {
  phase: "consultation",
  question: "What should I focus on?",
  spread: [
    { cardId: "major-00-fool", positionId: "signal" },
    { cardId: "major-09-hermit", positionId: "tension" },
    { cardId: "major-17-star", positionId: "move" },
  ],
  answers: {},
  selectedId: "major-00-fool",
  remaining: 2,
  threads: {},
  draft: "",
};

describe("three-card session recovery", () => {
  it("round-trips a stable consultation through session storage", () => {
    const storage = createStorage();
    expect(writeThreeCardSession(session, storage)).toBe(true);
    expect(readThreeCardSession(storage)).toMatchObject(session);
    expect(hasRestorableThreeCardSession(storage)).toBe(true);
  });

  it("rejects incomplete or malformed sessions", () => {
    const storage = createStorage();
    storage.setItem(THREE_CARD_SESSION_KEY, JSON.stringify({ ...session, version: 1, spread: session.spread.slice(0, 2) }));
    expect(readThreeCardSession(storage)).toBeNull();
  });

  it("clears a completed session", () => {
    const storage = createStorage();
    writeThreeCardSession(session, storage);
    clearThreeCardSession(storage);
    expect(hasRestorableThreeCardSession(storage)).toBe(false);
  });
});
