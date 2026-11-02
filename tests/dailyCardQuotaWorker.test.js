import { describe, expect, it } from "vitest";
import worker from "../worker.js";
import { createInMemoryThreeCardQuotaBinding } from "../server/threeCardQuestionQuota.js";

function request(path, { cookie = "", body } = {}) {
  return new Request(`https://example.test${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe("daily card quota worker routes", () => {
  it("initializes the anonymous visitor, allows three turns, then returns reached limits", async () => {
    const env = { THREE_CARD_QUESTION_QUOTA: createInMemoryThreeCardQuotaBinding() };
    const statusResponse = await worker.fetch(request("/api/arcana/daily-card-quota"), env);
    const cookie = statusResponse.headers.get("Set-Cookie").split(";", 1)[0];

    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({ limit: 3, used: 0, remaining: 3 });

    for (let turn = 1; turn <= 3; turn += 1) {
      const response = await worker.fetch(request("/api/arcana/ask-stream", {
        cookie,
        body: {
          cardId: "major-00-fool",
          question: `Question ${turn}`,
          dailyTurnId: `daily-turn-${turn}`,
          history: [],
        },
      }), env);
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Arcana-Daily-Remaining")).toBe(String(3 - turn));
    }

    const blocked = await worker.fetch(request("/api/arcana/ask-stream", {
      cookie,
      body: {
        cardId: "major-00-fool",
        question: "Question 4",
        dailyTurnId: "daily-turn-4",
        history: [],
      },
    }), env);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({
      error: "reached limits",
      code: "daily_card_limit_reached",
      quota: { remaining: 0 },
    });
  });
});
