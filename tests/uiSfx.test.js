import { describe, expect, it, vi } from "vitest";
import { bindLivingArcanaUISFX, resolveAppActionCue } from "../src/audio/bindLivingArcanaUISFX.js";
import {
  createUISFXService,
  CARD_FLIP_CUE_VOLUME,
  runUISFXTask,
  STAR_APPEAR_SOUND_URL,
  STAR_CUE_VOLUME,
  STAR_DISAPPEAR_SOUND_URL,
  UI_SFX_PACK,
  UI_SFX_PREFERENCE_KEY,
} from "../src/audio/uiSfx.js";

function createStorage(initial = null) {
  const values = new Map(initial ? [[UI_SFX_PREFERENCE_KEY, JSON.stringify(initial)]] : []);
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    read: () => JSON.parse(values.get(UI_SFX_PREFERENCE_KEY)),
  };
}

function createPlayerHarness() {
  const events = [];
  const handles = [];
  const player = {
    play: vi.fn((cue) => {
      let resolveEnded;
      const ended = new Promise((resolve) => { resolveEnded = resolve; });
      const handle = {
        cue,
        ended,
        stop: vi.fn(() => {
          events.push(`stop:${cue}`);
          resolveEnded();
        }),
      };
      handles.push(handle);
      events.push(`play:${cue}`);
      return handle;
    }),
    setPack: vi.fn((pack) => events.push(`pack:${pack}`)),
    setVolume: vi.fn((volume) => events.push(`volume:${volume}`)),
    setEnabled: vi.fn((enabled) => events.push(`enabled:${enabled}`)),
    stopAll: vi.fn(() => events.push("stopAll")),
    destroy: vi.fn(async () => events.push("destroy")),
  };
  const createPlayer = vi.fn(() => player);
  return { createPlayer, events, handles, player };
}

describe("UI SFX service", () => {
  it("is SSR-safe and never constructs a player outside the client", () => {
    const harness = createPlayerHarness();
    const service = createUISFXService({ createPlayer: harness.createPlayer, storage: null, isClient: () => false });

    expect(service.activate("open")).toBeNull();
    expect(service.play("success")).toBeNull();
    expect(harness.createPlayer).not.toHaveBeenCalled();
  });

  it("creates one zen player lazily and reuses it across activations", () => {
    const harness = createPlayerHarness();
    const service = createUISFXService({ createPlayer: harness.createPlayer, storage: createStorage(), isClient: () => true });

    service.activate("start");
    service.activate("forward");

    expect(harness.createPlayer).toHaveBeenCalledTimes(1);
    expect(harness.createPlayer).toHaveBeenCalledWith({ pack: UI_SFX_PACK, volume: 0.7, enabled: true });
    expect(harness.player.play.mock.calls.map(([cue]) => cue)).toEqual(["start", "forward"]);
  });

  it("persists mute and volume, stopping loops before disabling playback", () => {
    const storage = createStorage({ enabled: true, volume: 0.4 });
    const harness = createPlayerHarness();
    const service = createUISFXService({ createPlayer: harness.createPlayer, storage, isClient: () => true });

    service.activate("start");
    const loop = service.startLoop("recording", "recording");
    service.setVolume(0.55);
    service.setEnabled(false);

    expect(loop.stop).toHaveBeenCalledOnce();
    expect(harness.events.indexOf("stop:recording")).toBeLessThan(harness.events.indexOf("enabled:false"));
    expect(harness.events.indexOf("stopAll")).toBeLessThan(harness.events.indexOf("enabled:false"));
    expect(storage.read()).toEqual({ enabled: false, volume: 0.55 });
    expect(service.play("receive")).toBeNull();
  });

  it("keeps loop starts idempotent and destroys cleanly before remount", async () => {
    const harness = createPlayerHarness();
    const service = createUISFXService({ createPlayer: harness.createPlayer, storage: createStorage(), isClient: () => true });

    service.activate("start");
    const first = service.startLoop("thinking", "processing");
    const second = service.startLoop("thinking", "processing");
    expect(second).toBe(first);
    expect(harness.player.play.mock.calls.filter(([cue]) => cue === "processing")).toHaveLength(1);

    await service.dispose();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(harness.player.destroy).toHaveBeenCalledOnce();

    service.activate("open");
    expect(harness.createPlayer).toHaveBeenCalledTimes(2);
  });

  it("prepares and plays the supplied flip sample through the shared sound preferences", async () => {
    const harness = createPlayerHarness();
    const source = {
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      addEventListener: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const gain = {
      gain: { value: 0, setValueAtTime: vi.fn() },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const context = {
      state: "suspended",
      currentTime: 1,
      destination: {},
      resume: vi.fn(() => { context.state = "running"; }),
      decodeAudioData: vi.fn(async () => ({ duration: 0.8 })),
      createBufferSource: vi.fn(() => source),
      createGain: vi.fn(() => gain),
      close: vi.fn(() => { context.state = "closed"; }),
    };
    const service = createUISFXService({
      createPlayer: harness.createPlayer,
      storage: createStorage(),
      isClient: () => true,
      createAudioContext: () => context,
      loadAudio: vi.fn(async () => new ArrayBuffer(8)),
    });

    await service.prepareCardFlip();
    service.activate("press");
    expect(harness.createPlayer).toHaveBeenCalledWith(expect.objectContaining({ context }));
    expect(service.playCardFlip()).toBe(source);
    expect(source.start).toHaveBeenCalledOnce();
    expect(gain.gain.value).toBeCloseTo(0.7 * CARD_FLIP_CUE_VOLUME);

    service.setVolume(0.45);
    expect(gain.gain.setValueAtTime).toHaveBeenCalledWith(0.45 * CARD_FLIP_CUE_VOLUME, 1);
    await service.dispose();
    expect(source.stop).toHaveBeenCalledOnce();
    expect(harness.player.destroy).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("preloads the paired star samples and schedules their animation-aligned peaks", async () => {
    const sources = [];
    const gains = [];
    const makeSource = () => ({
      buffer: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      addEventListener: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    });
    const context = {
      state: "suspended",
      currentTime: 2,
      destination: {},
      resume: vi.fn(() => { context.state = "running"; }),
      decodeAudioData: vi.fn(async () => ({ duration: 0.5 })),
      createBufferSource: vi.fn(() => {
        const source = makeSource();
        sources.push(source);
        return source;
      }),
      createGain: vi.fn(() => {
        const gain = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
        gains.push(gain);
        return gain;
      }),
      close: vi.fn(() => { context.state = "closed"; }),
    };
    const loadAudio = vi.fn(async () => new ArrayBuffer(8));
    const service = createUISFXService({
      createPlayer: createPlayerHarness().createPlayer,
      storage: createStorage(),
      isClient: () => true,
      createAudioContext: () => context,
      loadAudio,
    });

    await service.prepareStarSounds();
    service.playStarAppear({ delayMs: 286 });
    service.playStarDisappear();

    expect(loadAudio.mock.calls.map(([url]) => url)).toEqual([
      STAR_APPEAR_SOUND_URL,
      STAR_DISAPPEAR_SOUND_URL,
    ]);
    expect(sources[0].start).toHaveBeenCalledWith(2.286);
    expect(sources[1].start).toHaveBeenCalledWith(2);
    expect(gains.map(({ gain }) => gain.value)).toEqual([
      0.7 * STAR_CUE_VOLUME,
      0.7 * STAR_CUE_VOLUME,
    ]);
  });

  it("plays outcomes only after async success or failure and cleans loops on both exits", async () => {
    const calls = [];
    const service = {
      startLoop: vi.fn((key, cue) => calls.push(`start:${key}:${cue}`)),
      stopLoop: vi.fn((key) => calls.push(`stop:${key}`)),
      play: vi.fn((cue) => calls.push(`play:${cue}`)),
    };
    let resolve;
    const pending = new Promise((next) => { resolve = next; });
    const successful = runUISFXTask({ key: "ask", service, successCue: "receive", task: () => pending });

    expect(calls).toEqual(["start:ask:processing"]);
    resolve("answer");
    await expect(successful).resolves.toBe("answer");
    expect(calls).toEqual(["start:ask:processing", "stop:ask", "play:receive", "stop:ask"]);

    calls.length = 0;
    await expect(runUISFXTask({ key: "ask", service, task: async () => { throw new Error("offline"); } })).rejects.toThrow("offline");
    expect(calls).toEqual(["start:ask:processing", "stop:ask", "play:error", "stop:ask"]);
  });
});

describe("Living Arcana semantic mapping", () => {
  it("maps product outcomes rather than control shapes", () => {
    expect(resolveAppActionCue("draw", { view: "today" })).toBe("start");
    expect(resolveAppActionCue("flip", { view: "reading" })).toBeNull();
    expect(resolveAppActionCue("consultation", { view: "today" })).toBe("press");
    expect(resolveAppActionCue("home", { view: "archive" })).toBe("press");
    expect(resolveAppActionCue("full-card-open", { fullCardState: "closed" })).toBeNull();
    expect(resolveAppActionCue("focus-flip", { focusFlipped: true })).toBeNull();
    expect(resolveAppActionCue("archive", { view: "archive" })).toBeNull();
  });

  it("uses the synthesized click for pointer and keyboard activation without duplicate listeners", () => {
    const rootHandlers = {};
    const documentHandlers = {};
    const root = {
      dataset: { view: "today", cardState: "idle", fullCardState: "closed" },
      addEventListener: vi.fn((name, handler) => { rootHandlers[name] = handler; }),
      removeEventListener: vi.fn(),
      querySelector: vi.fn(() => null),
    };
    const documentTarget = {
      addEventListener: vi.fn((name, handler) => { documentHandlers[name] = handler; }),
      removeEventListener: vi.fn(),
    };
    const service = {
      activate: vi.fn(),
      activateCardFlip: vi.fn(),
      prepareCardFlip: vi.fn(),
      play: vi.fn(),
      stopAllLoops: vi.fn(),
    };
    const control = {
      disabled: false,
      dataset: { action: "draw" },
      classList: { contains: () => false },
      hasAttribute: () => false,
      closest: (selector) => selector === "[inert]" ? null : control,
    };
    const target = { closest: () => control };

    const cleanup = bindLivingArcanaUISFX(root, service, { documentTarget, Observer: null });
    expect(rootHandlers.pointerdown).toBeUndefined();
    expect(rootHandlers.keydown).toBeUndefined();
    rootHandlers.click({ target });
    expect(service.activate).toHaveBeenCalledTimes(1);
    expect(service.activate).toHaveBeenCalledWith("start");
    expect(service.prepareCardFlip).toHaveBeenCalledOnce();

    control.dataset.action = "flip";
    rootHandlers.click({ target });
    expect(service.activateCardFlip).toHaveBeenCalledOnce();
    expect(service.activate).toHaveBeenCalledTimes(1);

    control.dataset.action = "full-card-open";
    root.dataset.fullCardState = "closed";
    rootHandlers.click({ target });
    expect(service.activateCardFlip).toHaveBeenCalledTimes(2);
    expect(service.activate).toHaveBeenCalledTimes(1);

    cleanup();
    expect(service.stopAllLoops).toHaveBeenCalledOnce();
  });
});
