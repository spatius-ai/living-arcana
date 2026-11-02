import { describe, expect, it } from "vitest";
import { createPreRollBuffer, floatFrameToInt16 } from "../src/duplex/micPcm.js";

describe("floatFrameToInt16", () => {
  it("maps the float range onto s16le with clamping", () => {
    const out = floatFrameToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 32767, -32768, Math.round(0.5 * 32767)]);
  });
});

describe("createPreRollBuffer", () => {
  it("keeps roughly the last maxMs of frames", () => {
    const buffer = createPreRollBuffer(10, 1000); // 10 samples max
    buffer.push(new Int16Array(4).fill(1));
    buffer.push(new Int16Array(4).fill(2));
    buffer.push(new Int16Array(4).fill(3));
    // 12 samples total -> the oldest frame is dropped down to <= 10 (8 left).
    expect(buffer.size()).toBe(8);
    const flushed = buffer.flush();
    expect(flushed.map((frame) => frame[0])).toEqual([2, 3]);
    expect(buffer.size()).toBe(0);
  });

  it("never drops the only frame even when oversized", () => {
    const buffer = createPreRollBuffer(10, 1000);
    buffer.push(new Int16Array(64));
    expect(buffer.flush()).toHaveLength(1);
  });

  it("clear empties without returning frames", () => {
    const buffer = createPreRollBuffer(10, 1000);
    buffer.push(new Int16Array(4));
    buffer.clear();
    expect(buffer.flush()).toEqual([]);
  });
});
