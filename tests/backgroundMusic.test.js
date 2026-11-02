import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_MUSIC_DEFAULTS,
  BACKGROUND_MUSIC_PREFERENCE_KEY,
  BACKGROUND_MUSIC_RECORDING_DUCK,
  BACKGROUND_MUSIC_SPEECH_DUCK,
  createBackgroundMusicService,
} from "../src/audio/backgroundMusic.js";

function createStorage() {
  const values = new Map();
  return {
    getItem: vi.fn((key) => values.get(key) ?? null),
    setItem: vi.fn((key, value) => values.set(key, value)),
    read: () => JSON.parse(values.get(BACKGROUND_MUSIC_PREFERENCE_KEY)),
  };
}

function createAudioHarness() {
  const audioTracks = [];
  const createAudio = vi.fn((src) => {
    const handlers = new Map();
    const audio = {
      src,
      preload: "",
      loop: false,
      volume: 1,
      paused: true,
      currentTime: 0,
      play: vi.fn(() => {
        audio.paused = false;
        return Promise.resolve();
      }),
      pause: vi.fn(() => { audio.paused = true; }),
      load: vi.fn(),
      removeAttribute: vi.fn(),
      addEventListener: vi.fn((name, handler) => handlers.set(name, handler)),
      removeEventListener: vi.fn((name) => handlers.delete(name)),
      emit: (name) => handlers.get(name)?.(),
    };
    audioTracks.push(audio);
    return audio;
  });
  return { audioTracks, createAudio };
}

describe("background music service", () => {
  it("defaults on, starts when resumed, and alternates both tracks continuously", async () => {
    const storage = createStorage();
    const harness = createAudioHarness();
    const service = createBackgroundMusicService({
      sources: ["one.mp3", "two.mp3"],
      storage,
      isClient: () => true,
      createAudio: harness.createAudio,
    });

    expect(service.getPreferences()).toMatchObject({ enabled: true, playing: false });
    expect(harness.createAudio).not.toHaveBeenCalled();

    service.resume();
    expect(harness.createAudio).toHaveBeenCalledTimes(2);
    expect(harness.audioTracks[0].play).toHaveBeenCalledOnce();
    expect(harness.audioTracks[0].volume).toBe(BACKGROUND_MUSIC_DEFAULTS.volume);

    harness.audioTracks[0].emit("ended");
    expect(harness.audioTracks[1].play).toHaveBeenCalledOnce();
    harness.audioTracks[1].emit("ended");
    expect(harness.audioTracks[0].play).toHaveBeenCalledTimes(2);

    service.setEnabled(false);
    expect(harness.audioTracks.every((audio) => audio.paused)).toBe(true);
    expect(storage.read()).toEqual({ enabled: false, volume: BACKGROUND_MUSIC_DEFAULTS.volume });
  });

  it("uses the quietest active duck level for speech and microphone capture", () => {
    const harness = createAudioHarness();
    const service = createBackgroundMusicService({
      sources: ["one.mp3", "two.mp3"],
      storage: createStorage(),
      isClient: () => true,
      createAudio: harness.createAudio,
      now: () => 0,
      requestFrame: (callback) => { callback(1_000); return 1; },
      cancelFrame: vi.fn(),
    });
    service.setEnabled(true);

    service.setDucked("speech", true, BACKGROUND_MUSIC_SPEECH_DUCK);
    expect(harness.audioTracks[0].volume).toBeCloseTo(BACKGROUND_MUSIC_DEFAULTS.volume * BACKGROUND_MUSIC_SPEECH_DUCK);
    service.setDucked("microphone", true, BACKGROUND_MUSIC_RECORDING_DUCK);
    expect(harness.audioTracks[0].volume).toBeCloseTo(BACKGROUND_MUSIC_DEFAULTS.volume * BACKGROUND_MUSIC_RECORDING_DUCK);
    service.setDucked("microphone", false);
    expect(harness.audioTracks[0].volume).toBeCloseTo(BACKGROUND_MUSIC_DEFAULTS.volume * BACKGROUND_MUSIC_SPEECH_DUCK);
    service.setDucked("speech", false);
    expect(harness.audioTracks[0].volume).toBeCloseTo(BACKGROUND_MUSIC_DEFAULTS.volume);
  });

  it("is safe outside the browser", () => {
    const harness = createAudioHarness();
    const service = createBackgroundMusicService({
      storage: null,
      isClient: () => false,
      createAudio: harness.createAudio,
    });

    service.setEnabled(true);
    expect(harness.createAudio).not.toHaveBeenCalled();
    expect(service.isPlaying()).toBe(false);
  });
});
