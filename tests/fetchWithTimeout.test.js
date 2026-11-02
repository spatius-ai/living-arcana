import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "../src/reading/fetchWithTimeout.js";

const hangingFetch = () => vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
}));

describe("fetchWithTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects with a TimeoutError when the request hangs", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const request = fetchWithTimeout("/slow", {}, 5_000);
    const settled = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(5_000);
    await settled;
  });

  it("resolves normally and passes options through", async () => {
    const fetchMock = vi.fn(async () => "response");
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithTimeout("/ok", { method: "POST" }, 5_000)).resolves.toBe("response");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });

  it("still honours the caller's abort signal", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const controller = new AbortController();
    const request = fetchWithTimeout("/slow", { signal: controller.signal }, 60_000);
    controller.abort(new DOMException("Aborted", "AbortError"));
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
