import { describe, expect, it, vi } from "vitest";
import { requestWithRetry } from "../src/reading/requestWithRetry.js";

describe("requestWithRetry", () => {
  it("retries once after a transient failure", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce("live answer");
    const waitImpl = vi.fn(async () => {});
    const onRetry = vi.fn();

    await expect(requestWithRetry(request, { waitImpl, onRetry, retryDelayMs: 320 })).resolves.toBe("live answer");
    expect(request).toHaveBeenCalledTimes(2);
    expect(waitImpl).toHaveBeenCalledWith(320, undefined);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, nextDelayMs: 320 }));
  });

  it("surfaces the final error instead of substituting content", async () => {
    const finalError = new Error("still unavailable");
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockRejectedValueOnce(finalError);

    await expect(requestWithRetry(request, { waitImpl: async () => {} })).rejects.toBe(finalError);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not start or retry an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn();

    await expect(requestWithRetry(request, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels a pending background retry when the reading is abandoned", async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => { throw new Error("offline"); });
    const pending = requestWithRetry(request, {
      attempts: Number.POSITIVE_INFINITY,
      retryDelayMs: 10_000,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps retrying with capped exponential backoff until a live answer arrives", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("one"))
      .mockRejectedValueOnce(new Error("two"))
      .mockRejectedValueOnce(new Error("three"))
      .mockResolvedValueOnce("live answer");
    const waitImpl = vi.fn(async () => {});

    await expect(requestWithRetry(request, {
      attempts: Number.POSITIVE_INFINITY,
      retryDelayMs: 300,
      maxRetryDelayMs: 700,
      waitImpl,
    })).resolves.toBe("live answer");
    expect(waitImpl.mock.calls.map(([delay]) => delay)).toEqual([300, 600, 700]);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("aborts a stalled attempt and retries with a timeout error", async () => {
    const request = vi.fn()
      .mockImplementationOnce(({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }))
      .mockResolvedValueOnce("live answer");
    const onRetry = vi.fn();

    await expect(requestWithRetry(request, {
      attempts: 2,
      attemptTimeoutMs: 5,
      retryDelayMs: 0,
      waitImpl: async () => {},
      onRetry,
    })).resolves.toBe("live answer");

    expect(request).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      error: expect.objectContaining({ name: "TimeoutError", code: "request_timeout" }),
    }));
  });
});
