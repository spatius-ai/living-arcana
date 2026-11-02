const DEFAULT_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 480;

function createAbortError() {
  if (typeof DOMException === "function") return new DOMException("The request was aborted.", "AbortError");
  const error = new Error("The request was aborted.");
  error.name = "AbortError";
  return error;
}

function createTimeoutError(timeoutMs) {
  const error = new Error(`The live answer request timed out after ${timeoutMs}ms.`);
  error.name = "TimeoutError";
  error.code = "request_timeout";
  return error;
}

async function runAttempt(request, { attempt, signal, attemptTimeoutMs }) {
  if (!attemptTimeoutMs || typeof AbortController !== "function") {
    return request({ attempt, signal });
  }

  const attemptController = new AbortController();
  let timedOut = false;
  const abortAttempt = () => attemptController.abort();
  signal?.addEventListener("abort", abortAttempt, { once: true });
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    attemptController.abort();
  }, Math.max(1, attemptTimeoutMs));

  try {
    return await request({ attempt, signal: attemptController.signal });
  } catch (error) {
    if (timedOut && !signal?.aborted) throw createTimeoutError(attemptTimeoutMs);
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortAttempt);
  }
}

function waitForRetry(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      globalThis.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(createAbortError());
    };
    const timer = globalThis.setTimeout(finish, Math.max(0, delayMs));
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Runs a live answer request again after a short, abortable backoff. */
export async function requestWithRetry(request, {
  attempts = DEFAULT_ATTEMPTS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxRetryDelayMs = 12_000,
  attemptTimeoutMs = 0,
  signal,
  onRetry,
  waitImpl = waitForRetry,
} = {}) {
  const attemptLimit = attempts === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Math.max(1, Math.floor(attempts));
  let lastError;

  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    if (signal?.aborted) throw createAbortError();
    try {
      return await runAttempt(request, { attempt, signal, attemptTimeoutMs });
    } catch (error) {
      if (signal?.aborted) throw createAbortError();
      if (error?.name === "AbortError") throw error;
      lastError = error;
      if (attempt === attemptLimit) break;
      const nextDelayMs = Math.min(maxRetryDelayMs, retryDelayMs * (2 ** (attempt - 1)));
      onRetry?.({ attempt, error, nextDelayMs });
      await waitImpl(nextDelayMs, signal);
    }
  }

  throw lastError || new Error("The live answer request failed.");
}
