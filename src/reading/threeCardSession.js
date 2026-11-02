export const THREE_CARD_SESSION_KEY = "living-arcana.three-card-session.v1";
export const LAST_VIEW_SESSION_KEY = "living-arcana.last-view.v1";

const RESTORABLE_PHASES = new Set(["spread", "consultation"]);

function getSessionStorage() {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readThreeCardSession(storage = getSessionStorage()) {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(THREE_CARD_SESSION_KEY));
    if (!value || value.version !== 1 || !RESTORABLE_PHASES.has(value.phase)) return null;
    if (typeof value.question !== "string" || !value.question.trim()) return null;
    if (!Array.isArray(value.spread) || value.spread.length !== 3) return null;
    if (new Set(value.spread.map((entry) => entry?.cardId)).size !== 3) return null;
    return value;
  } catch {
    return null;
  }
}

export function writeThreeCardSession(value, storage = getSessionStorage()) {
  if (!storage || !value || !RESTORABLE_PHASES.has(value.phase)) return false;
  try {
    storage.setItem(THREE_CARD_SESSION_KEY, JSON.stringify({ ...value, version: 1 }));
    return true;
  } catch {
    return false;
  }
}

export function clearThreeCardSession(storage = getSessionStorage()) {
  try {
    storage?.removeItem(THREE_CARD_SESSION_KEY);
  } catch {
    // Session recovery is best-effort when storage is unavailable.
  }
}

export function readLastView(storage = getSessionStorage()) {
  try {
    return storage?.getItem(LAST_VIEW_SESSION_KEY) || "";
  } catch {
    return "";
  }
}

export function hasRestorableThreeCardSession(storage = getSessionStorage()) {
  return Boolean(readThreeCardSession(storage));
}
