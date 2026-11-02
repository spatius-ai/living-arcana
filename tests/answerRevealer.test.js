import { describe, expect, it } from "vitest";
import { charDurationMs, createAnswerRevealer, PCM_BYTES_PER_MS } from "../src/duplex/answerRevealer.js";

function makeRevealer(overrides = {}) {
  let clock = 0;
  const reveals = [];
  const revealer = createAnswerRevealer({
    onReveal: (text) => reveals.push(text),
    prebufferMs: 200,
    stallTimeoutMs: 3000,
    now: () => clock,
    ...overrides,
  });
  return { revealer, reveals, advance: (ms) => { clock += ms; } };
}

const secondsOfPcm = (seconds) => seconds * 1000 * PCM_BYTES_PER_MS;

describe("charDurationMs", () => {
  it("treats CJK as slow syllables and latin as fast letters", () => {
    expect(charDurationMs("塔")).toBe(235);
    expect(charDurationMs("。")).toBe(260);
    expect(charDurationMs("a")).toBe(72);
    expect(charDurationMs(" ")).toBe(55);
  });
});

describe("createAnswerRevealer", () => {
  it("reveals nothing until audio is actually fed", () => {
    const { revealer, reveals, advance } = makeRevealer();
    revealer.setText("塔罗牌在此。");
    advance(1000);
    expect(revealer.tick()).toBe(false);
    expect(reveals).toEqual([]);
  });

  it("paces characters on the audio clock after the prebuffer", () => {
    const { revealer, reveals, advance } = makeRevealer();
    revealer.setText("塔罗牌");
    revealer.notifyPcm(secondsOfPcm(10));
    // 200 ms prebuffer + one 235 ms syllable
    advance(200 + 235);
    revealer.tick();
    expect(reveals.at(-1)).toBe("塔");
    advance(235 * 2);
    revealer.tick();
    expect(reveals.at(-1)).toBe("塔罗牌");
  });

  it("never runs ahead of the bytes fed so far", () => {
    const { revealer, reveals, advance } = makeRevealer();
    revealer.setText("塔罗牌今日想说");
    revealer.notifyPcm(Math.round(secondsOfPcm(0.435))); // audio for ~1 syllable past prebuffer
    advance(10_000);
    revealer.tick();
    expect(reveals.at(-1)).toBe("塔");
    revealer.notifyPcm(secondsOfPcm(10));
    revealer.tick();
    expect(reveals.at(-1)).toBe("塔罗牌今日想说");
  });

  it("degrades to immediate reveal when no audio arrives at all", () => {
    const { revealer, reveals, advance } = makeRevealer();
    revealer.setText("无声的回答");
    advance(3000);
    revealer.tick();
    expect(reveals.at(-1)).toBe("无声的回答");
    revealer.setText("无声的回答，继续");
    expect(reveals.at(-1)).toBe("无声的回答，继续");
  });

  it("rescales the remaining schedule once the audio length is known", () => {
    const { revealer, reveals, advance } = makeRevealer();
    revealer.setText("四字回答"); // schedule: 4 x 235 = 940 ms
    revealer.notifyPcm(secondsOfPcm(1.88)); // real speech is twice as slow
    revealer.markAudioComplete(); // scale = 1880 / 940 = 2 -> clamped to 1.8
    advance(200 + 235 * 1.8 + 1);
    revealer.tick();
    expect(reveals.at(-1)).toBe("四");
  });

  it("finishes only when audio is complete and all text is out", () => {
    const { revealer, advance } = makeRevealer();
    revealer.setText("完");
    revealer.notifyPcm(secondsOfPcm(10));
    advance(200 + 235 + 1);
    expect(revealer.tick()).toBe(false); // audio not marked complete yet
    revealer.markAudioComplete();
    expect(revealer.tick()).toBe(true);
  });

  it("snap shows everything instantly; cancel stops without revealing", () => {
    const snapped = makeRevealer();
    snapped.revealer.setText("被打断的完整回答");
    snapped.revealer.snap();
    expect(snapped.reveals.at(-1)).toBe("被打断的完整回答");
    expect(snapped.revealer.tick()).toBe(true);

    const cancelled = makeRevealer();
    cancelled.revealer.setText("将被错误信息覆盖");
    cancelled.revealer.cancel();
    cancelled.advance(10_000);
    expect(cancelled.revealer.tick()).toBe(true);
    expect(cancelled.reveals).toEqual([]);
  });

  it("resets the schedule when the text is replaced rather than extended", () => {
    const { revealer, reveals } = makeRevealer();
    revealer.setText("第一次尝试的文本");
    revealer.setText("换了个答案");
    revealer.snap();
    expect(reveals.at(-1)).toBe("换了个答案");
  });
});
