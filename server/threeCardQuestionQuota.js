export const THREE_CARD_QUESTION_QUOTA_PATH = "/api/arcana/three-card-quota";
export const THREE_CARD_DAILY_QUESTION_LIMIT = 3;
export const DAILY_CARD_QUESTION_QUOTA_PATH = "/api/arcana/daily-card-quota";
export const DAILY_CARD_DAILY_QUESTION_LIMIT = 3;
export const THREE_CARD_QUOTA_TIME_ZONE = "Asia/Singapore";
export const THREE_CARD_VISITOR_COOKIE = "arcana_visitor";

const QUOTA_STORAGE_KEYS = Object.freeze({
  "three-card": "daily-question-quota",
  "daily-card": "daily-card-turn-quota",
});
const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;

function readHeader(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  return headers?.[name.toLowerCase()] || headers?.[name] || "";
}

export function isValidQuotaId(value) {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export function readThreeCardVisitorId(cookieHeader = "") {
  for (const part of String(cookieHeader).split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== THREE_CARD_VISITOR_COOKIE) continue;
    try {
      const value = decodeURIComponent(rawValue.join("="));
      return isValidQuotaId(value) ? value : "";
    } catch {
      return "";
    }
  }
  return "";
}

export function createThreeCardVisitorId(cryptoImpl = globalThis.crypto) {
  const id = cryptoImpl?.randomUUID?.();
  if (id) return id;

  const bytes = new Uint8Array(18);
  cryptoImpl?.getRandomValues?.(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function resolveThreeCardVisitor(headers, cryptoImpl = globalThis.crypto) {
  const existing = readThreeCardVisitorId(readHeader(headers, "Cookie"));
  return existing
    ? { id: existing, isNew: false }
    : { id: createThreeCardVisitorId(cryptoImpl), isNew: true };
}

export function serializeThreeCardVisitorCookie(visitorId, { secure = true } = {}) {
  if (!isValidQuotaId(visitorId)) throw new Error("A valid visitor ID is required.");
  return [
    `${THREE_CARD_VISITOR_COOKIE}=${encodeURIComponent(visitorId)}`,
    "Path=/",
    `Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function datePartsAt(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function timeZoneOffsetMs(now, timeZone) {
  const parts = datePartsAt(now, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - now.getTime();
}

export function threeCardQuotaDate(now = new Date(), timeZone = THREE_CARD_QUOTA_TIME_ZONE) {
  const parts = datePartsAt(now, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function threeCardQuotaResetAt(now = new Date(), timeZone = THREE_CARD_QUOTA_TIME_ZONE) {
  const parts = datePartsAt(now, timeZone);
  const nextLocalMidnightAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day + 1);
  let candidate = new Date(nextLocalMidnightAsUtc - timeZoneOffsetMs(new Date(nextLocalMidnightAsUtc), timeZone));
  candidate = new Date(nextLocalMidnightAsUtc - timeZoneOffsetMs(candidate, timeZone));
  return candidate.toISOString();
}

export function normalizeThreeCardDailyLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 20
    ? parsed
    : THREE_CARD_DAILY_QUESTION_LIMIT;
}

function quotaSnapshot({ requestIds = [], limit, date, resetAt, allowed }) {
  const used = Math.min(limit, requestIds.length);
  return {
    ...(typeof allowed === "boolean" ? { allowed } : {}),
    limit,
    used,
    remaining: Math.max(0, limit - used),
    date,
    resetAt,
  };
}

export class ThreeCardQuestionQuota {
  constructor(ctx) {
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });

    const payload = await request.json().catch(() => null);
    const action = payload?.action;
    const scope = Object.hasOwn(QUOTA_STORAGE_KEYS, payload?.scope) ? payload.scope : "three-card";
    const storageKey = QUOTA_STORAGE_KEYS[scope];
    const date = typeof payload?.date === "string" ? payload.date : "";
    const resetAt = typeof payload?.resetAt === "string" ? payload.resetAt : "";
    const limit = normalizeThreeCardDailyLimit(payload?.limit);
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date) || !resetAt || !["status", "consume"].includes(action)) {
      return Response.json({ error: "The quota request is invalid." }, { status: 400 });
    }

    if (action === "status") {
      const saved = await this.ctx.storage.get(storageKey);
      const requestIds = saved?.date === date && Array.isArray(saved.requestIds)
        ? saved.requestIds
        : saved?.date === date && Array.isArray(saved.consultationIds)
          ? saved.consultationIds
          : [];
      return Response.json(quotaSnapshot({ requestIds, limit, date, resetAt }));
    }

    const consultationId = payload?.consultationId;
    if (!isValidQuotaId(consultationId)) {
      return Response.json({ error: "A valid consultation ID is required." }, { status: 400 });
    }

    const snapshot = await this.ctx.storage.transaction(async (transaction) => {
      const saved = await transaction.get(storageKey);
      const requestIds = saved?.date === date && Array.isArray(saved.requestIds)
        ? [...saved.requestIds]
        : saved?.date === date && Array.isArray(saved.consultationIds)
          ? [...saved.consultationIds]
          : [];

      if (requestIds.includes(consultationId)) {
        return quotaSnapshot({ requestIds, limit, date, resetAt, allowed: true });
      }
      if (requestIds.length >= limit) {
        return quotaSnapshot({ requestIds, limit, date, resetAt, allowed: false });
      }

      requestIds.push(consultationId);
      await transaction.put(storageKey, { date, requestIds });
      return quotaSnapshot({ requestIds, limit, date, resetAt, allowed: true });
    });

    return Response.json(snapshot);
  }
}

async function callQuestionQuota(binding, visitorId, payload) {
  if (!binding || !isValidQuotaId(visitorId)) throw new Error("The question quota is unavailable.");
  const objectId = binding.idFromName(visitorId);
  const response = await binding.get(objectId).fetch("https://three-card-quota.internal/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.error || "The question quota is unavailable.");
  return result;
}

function quotaRequestPayload({
  now = new Date(),
  timeZone = THREE_CARD_QUOTA_TIME_ZONE,
  limit = THREE_CARD_DAILY_QUESTION_LIMIT,
  scope = "three-card",
}) {
  return {
    scope,
    date: threeCardQuotaDate(now, timeZone),
    resetAt: threeCardQuotaResetAt(now, timeZone),
    limit: normalizeThreeCardDailyLimit(limit),
  };
}

export function getThreeCardQuestionQuota(binding, visitorId, options = {}) {
  return callQuestionQuota(binding, visitorId, {
    action: "status",
    ...quotaRequestPayload(options),
  });
}

export function consumeThreeCardQuestionQuota(binding, visitorId, consultationId, options = {}) {
  return callQuestionQuota(binding, visitorId, {
    action: "consume",
    consultationId,
    ...quotaRequestPayload(options),
  });
}

export function getDailyCardQuestionQuota(binding, visitorId, options = {}) {
  return callQuestionQuota(binding, visitorId, {
    action: "status",
    ...quotaRequestPayload({
      limit: DAILY_CARD_DAILY_QUESTION_LIMIT,
      scope: "daily-card",
      ...options,
    }),
  });
}

export function consumeDailyCardQuestionQuota(binding, visitorId, turnId, options = {}) {
  return callQuestionQuota(binding, visitorId, {
    action: "consume",
    consultationId: turnId,
    ...quotaRequestPayload({
      limit: DAILY_CARD_DAILY_QUESTION_LIMIT,
      scope: "daily-card",
      ...options,
    }),
  });
}

function createMemoryStorage() {
  const values = new Map();
  const storage = {
    get: async (key) => values.get(key),
    put: async (key, value) => { values.set(key, value); },
  };
  storage.transaction = async (callback) => callback(storage);
  return storage;
}

export function createInMemoryThreeCardQuotaBinding() {
  const objects = new Map();
  return {
    idFromName: (name) => name,
    get(id) {
      if (!objects.has(id)) {
        const instance = new ThreeCardQuestionQuota({ storage: createMemoryStorage() });
        objects.set(id, { instance, queue: Promise.resolve() });
      }
      const entry = objects.get(id);
      return {
        fetch(url, init) {
          const request = new Request(url, init);
          const result = entry.queue.then(() => entry.instance.fetch(request));
          entry.queue = result.then(() => undefined, () => undefined);
          return result;
        },
      };
    },
  };
}
