import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COLLECTION_CHANGE_EVENT,
  COLLECTION_STORAGE_KEY,
  DAILY_DRAW_STORAGE_KEY,
  getCardById,
  getCardByReference,
  getCollectedIndexSet,
  getDailyCard,
  getLocalDateKey,
  hasCompletedDailyDraw,
  PRECOLLECTED,
  readDailyDraw,
  recordDailyDraw,
  TAROT_CARDS,
} from "../src/data/tarot.js";

function installWindow() {
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  const target = new EventTarget();
  target.localStorage = localStorage;
  globalThis.window = target;
  return { store, target };
}

afterEach(() => {
  delete globalThis.window;
});

describe("getLocalDateKey", () => {
  it("pads month and day to two digits", () => {
    expect(getLocalDateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(getLocalDateKey(new Date(2026, 10, 30))).toBe("2026-11-30");
  });
});

describe("getDailyCard", () => {
  it("is deterministic for a given date", () => {
    const date = new Date(2026, 7, 18);
    expect(getDailyCard(date).id).toBe(getDailyCard(date).id);
  });

  it("keeps the verified 2026-08-18 anchor (The Fool)", () => {
    // Locked to the live-verified draw for 2026-08-18; a change here means
    // the hash changed and every user's daily card would shift.
    expect(getDailyCard(new Date(2026, 7, 18)).id).toBe("major-00-fool");
  });

  it("spreads across the deck over consecutive days", () => {
    const seen = new Set();
    for (let day = 1; day <= 60; day += 1) {
      seen.add(getDailyCard(new Date(2026, 0, day)).id);
    }
    expect(seen.size).toBeGreaterThan(5);
  });
});

describe("getCardByReference", () => {
  it("resolves indexes, ids, slugs and names case-insensitively", () => {
    expect(getCardByReference("0")).toBe(TAROT_CARDS[0]);
    expect(getCardByReference(21)).toBe(TAROT_CARDS[21]);
    expect(getCardByReference(TAROT_CARDS[1].id)).toBe(TAROT_CARDS[1]);
    expect(getCardByReference(TAROT_CARDS[1].slug.toUpperCase())).toBe(TAROT_CARDS[1]);
    expect(getCardByReference(` ${TAROT_CARDS[2].name.toLowerCase()} `)).toBe(TAROT_CARDS[2]);
  });

  it("rejects unknown references", () => {
    expect(getCardByReference("")).toBeNull();
    expect(getCardByReference(null)).toBeNull();
    expect(getCardByReference("22")).toBeNull();
    expect(getCardByReference("-1")).toBeNull();
    expect(getCardByReference("not-a-card")).toBeNull();
  });
});

describe("daily draw persistence", () => {
  beforeEach(() => {
    installWindow();
  });

  it("records the draw and enforces once-a-day per card and date", () => {
    const date = new Date(2026, 7, 18);
    const card = getDailyCard(date);
    recordDailyDraw(card.id, date);

    expect(readDailyDraw()).toEqual({ dateKey: "2026-08-18", cardId: card.id });
    expect(hasCompletedDailyDraw(card.id, date)).toBe(true);
    expect(hasCompletedDailyDraw(card.id, new Date(2026, 7, 19))).toBe(false);
    const otherCard = TAROT_CARDS.find((candidate) => candidate.id !== card.id);
    expect(hasCompletedDailyDraw(otherCard.id, date)).toBe(false);
  });

  it("adds the drawn card to the collection and announces the change", () => {
    const events = [];
    window.addEventListener(COLLECTION_CHANGE_EVENT, (event) => events.push(event.detail));
    const uncollected = TAROT_CARDS.find((card, index) => !PRECOLLECTED.has(index));

    recordDailyDraw(uncollected.id, new Date(2026, 7, 18));

    const indexes = getCollectedIndexSet();
    for (const index of PRECOLLECTED) expect(indexes.has(index)).toBe(true);
    expect(indexes.has(TAROT_CARDS.indexOf(uncollected))).toBe(true);
    expect(events).toEqual([{ cardId: uncollected.id }]);
  });

  it("ignores unknown cards and survives corrupted storage", () => {
    recordDailyDraw("not-a-card", new Date(2026, 7, 18));
    expect(readDailyDraw()).toBeNull();

    window.localStorage.setItem(DAILY_DRAW_STORAGE_KEY, "{corrupt");
    window.localStorage.setItem(COLLECTION_STORAGE_KEY, "[not json");
    expect(readDailyDraw()).toBeNull();
    expect(getCollectedIndexSet()).toEqual(new Set(PRECOLLECTED));
  });

  it("resolves ids strictly", () => {
    expect(getCardById(TAROT_CARDS[3].id)).toBe(TAROT_CARDS[3]);
    expect(getCardById("major-99-nope")).toBeNull();
  });
});
