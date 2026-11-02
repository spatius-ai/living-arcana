import { describe, expect, it } from "vitest";
import {
  consumeDailyCardQuestionQuota,
  consumeThreeCardQuestionQuota,
  createInMemoryThreeCardQuotaBinding,
  getDailyCardQuestionQuota,
  getThreeCardQuestionQuota,
  readThreeCardVisitorId,
  serializeThreeCardVisitorCookie,
  threeCardQuotaDate,
  threeCardQuotaResetAt,
} from "../server/threeCardQuestionQuota.js";

describe("Three Cards daily question quota", () => {
  it("counts three distinct consultations, while repeated card requests remain idempotent", async () => {
    const binding = createInMemoryThreeCardQuotaBinding();
    const visitorId = "visitor-12345678";
    const now = new Date("2026-08-24T10:00:00.000Z");

    expect(await getThreeCardQuestionQuota(binding, visitorId, { now })).toMatchObject({
      limit: 3,
      used: 0,
      remaining: 3,
    });

    expect(await consumeThreeCardQuestionQuota(binding, visitorId, "consultation-one", { now })).toMatchObject({ allowed: true, used: 1 });
    expect(await consumeThreeCardQuestionQuota(binding, visitorId, "consultation-one", { now })).toMatchObject({ allowed: true, used: 1 });
    expect(await consumeThreeCardQuestionQuota(binding, visitorId, "consultation-two", { now })).toMatchObject({ allowed: true, used: 2 });
    expect(await consumeThreeCardQuestionQuota(binding, visitorId, "consultation-three", { now })).toMatchObject({ allowed: true, used: 3, remaining: 0 });
    expect(await consumeThreeCardQuestionQuota(binding, visitorId, "consultation-four", { now })).toMatchObject({ allowed: false, used: 3, remaining: 0 });
  });

  it("resets on the next Singapore calendar day", async () => {
    const binding = createInMemoryThreeCardQuotaBinding();
    const visitorId = "visitor-12345678";
    const firstDay = new Date("2026-08-24T10:00:00.000Z");
    const nextDay = new Date("2026-08-24T16:01:00.000Z");

    await consumeThreeCardQuestionQuota(binding, visitorId, "consultation-one", { now: firstDay });
    expect(await getThreeCardQuestionQuota(binding, visitorId, { now: nextDay })).toMatchObject({ used: 0, remaining: 3 });
  });

  it("uses Singapore midnight for the date and reset time", () => {
    const now = new Date("2026-08-24T15:59:00.000Z");
    expect(threeCardQuotaDate(now)).toBe("2026-08-24");
    expect(threeCardQuotaResetAt(now)).toBe("2026-08-24T16:00:00.000Z");
  });

  it("round-trips the anonymous visitor cookie and rejects malformed values", () => {
    const cookie = serializeThreeCardVisitorCookie("visitor-12345678");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(readThreeCardVisitorId(cookie)).toBe("visitor-12345678");
    expect(readThreeCardVisitorId("arcana_visitor=%E0%A4%A")).toBe("");
  });
});

describe("Today card daily question quota", () => {
  it("allows three idempotent turns and keeps its count separate from Three Cards", async () => {
    const binding = createInMemoryThreeCardQuotaBinding();
    const visitorId = "visitor-12345678";
    const now = new Date("2026-08-24T10:00:00.000Z");

    await consumeThreeCardQuestionQuota(binding, visitorId, "consultation-one", { now });
    expect(await getDailyCardQuestionQuota(binding, visitorId, { now })).toMatchObject({
      limit: 3,
      used: 0,
      remaining: 3,
    });

    expect(await consumeDailyCardQuestionQuota(binding, visitorId, "daily-turn-one", { now })).toMatchObject({ allowed: true, used: 1 });
    expect(await consumeDailyCardQuestionQuota(binding, visitorId, "daily-turn-one", { now })).toMatchObject({ allowed: true, used: 1 });
    expect(await consumeDailyCardQuestionQuota(binding, visitorId, "daily-turn-two", { now })).toMatchObject({ allowed: true, used: 2 });
    expect(await consumeDailyCardQuestionQuota(binding, visitorId, "daily-turn-three", { now })).toMatchObject({ allowed: true, used: 3, remaining: 0 });
    expect(await consumeDailyCardQuestionQuota(binding, visitorId, "daily-turn-four", { now })).toMatchObject({ allowed: false, used: 3, remaining: 0 });

    expect(await getThreeCardQuestionQuota(binding, visitorId, { now })).toMatchObject({ used: 1, remaining: 2 });
  });
});
