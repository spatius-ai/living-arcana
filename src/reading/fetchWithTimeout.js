// fetch() never gives up on its own: a request that hangs leaves its caller's
// busy state ("starting", "transcribing") set forever. This rejects with a
// TimeoutError instead, which callers already handle as an ordinary failure.
// The timer covers the wait for response headers; an optional caller signal
// still aborts the request as before.
export function fetchWithTimeout(url, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const outer = options.signal;
  const forward = () => controller.abort(outer.reason);
  if (outer?.aborted) forward();
  else outer?.addEventListener("abort", forward, { once: true });

  const timer = setTimeout(() => {
    controller.abort(new DOMException("The request timed out.", "TimeoutError"));
  }, timeoutMs);

  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener("abort", forward);
  });
}
