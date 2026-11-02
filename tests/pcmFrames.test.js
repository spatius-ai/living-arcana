import { describe, expect, it } from "vitest";
import { splitPcmFrames } from "../src/spatius/pcmFrames.js";

const empty = new Uint8Array(0);
const bytes = (...values) => new Uint8Array(values);

describe("splitPcmFrames", () => {
  it("passes even-length chunks through untouched", () => {
    const { send, remainder } = splitPcmFrames(empty, bytes(1, 2, 3, 4));
    expect(new Uint8Array(send)).toEqual(bytes(1, 2, 3, 4));
    expect(remainder.byteLength).toBe(0);
  });

  it("carries the trailing byte of an odd-length chunk into the next call", () => {
    const first = splitPcmFrames(empty, bytes(1, 2, 3));
    expect(new Uint8Array(first.send)).toEqual(bytes(1, 2));
    expect(first.remainder).toEqual(bytes(3));

    // The carried byte must lead the next chunk — this ordering is what keeps
    // every later sample aligned (a dropped byte turns speech into static).
    const second = splitPcmFrames(first.remainder, bytes(4, 5, 6));
    expect(new Uint8Array(second.send)).toEqual(bytes(3, 4, 5, 6));
    expect(second.remainder.byteLength).toBe(0);
  });

  it("holds a lone byte until a frame completes", () => {
    const first = splitPcmFrames(empty, bytes(9));
    expect(first.send).toBeNull();
    expect(first.remainder).toEqual(bytes(9));

    const second = splitPcmFrames(first.remainder, bytes(10));
    expect(new Uint8Array(second.send)).toEqual(bytes(9, 10));
    expect(second.remainder.byteLength).toBe(0);
  });

  it("always flushes on last, dropping a trailing half frame", () => {
    const result = splitPcmFrames(bytes(1), bytes(2, 3, 4), true);
    expect(new Uint8Array(result.send)).toEqual(bytes(1, 2, 3, 4));
    expect(result.remainder.byteLength).toBe(0);

    const oddTail = splitPcmFrames(empty, bytes(1, 2, 3), true);
    expect(new Uint8Array(oddTail.send)).toEqual(bytes(1, 2));
    expect(oddTail.remainder.byteLength).toBe(0);

    const nothing = splitPcmFrames(empty, empty, true);
    expect(nothing.send.byteLength).toBe(0);
    expect(nothing.remainder.byteLength).toBe(0);
  });

  it("reassembles a stream split at arbitrary boundaries", () => {
    const source = Uint8Array.from({ length: 257 }, (_, i) => i % 256);
    const out = [];
    let remainder = empty;
    for (const size of [1, 2, 5, 1, 3, 64, 7, 100, 74]) {
      const offset = out.reduce((sum, part) => sum + part.byteLength, 0) + remainder.byteLength;
      const { send, remainder: next } = splitPcmFrames(remainder, source.slice(offset, offset + size));
      if (send) out.push(new Uint8Array(send));
      remainder = next;
    }
    const flush = splitPcmFrames(remainder, empty, true);
    out.push(new Uint8Array(flush.send));
    const joined = new Uint8Array(out.reduce((sum, part) => sum + part.byteLength, 0));
    let cursor = 0;
    for (const part of out) { joined.set(part, cursor); cursor += part.byteLength; }
    // 257 bytes = 128 whole frames + one dangling byte dropped at flush.
    expect(joined).toEqual(source.slice(0, 256));
  });
});
