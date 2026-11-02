import { createUISFX } from "uisfx";

export const UI_SFX_PACK = "zen";
export const UI_SFX_PREFERENCE_KEY = "living-arcana.ui-sfx.v1";
export const UI_SFX_DEFAULTS = Object.freeze({ enabled: true, volume: 0.7 });
export const CARD_FLIP_SOUND_URL = "/assets/audio/card-flip.m4a";
export const CARD_FLIP_CUE_VOLUME = 0.18;
export const STAR_APPEAR_SOUND_URL = "/assets/audio/star-appear.m4a";
export const STAR_DISAPPEAR_SOUND_URL = "/assets/audio/star-disappear.m4a";
export const STAR_CUE_VOLUME = 0.24;

const LOOP_CUES = new Set(["loading", "processing", "recording", "connecting", "scanning", "streaming"]);
const ONE_SHOT_SAMPLES = Object.freeze({
  cardFlip: { url: CARD_FLIP_SOUND_URL, volume: CARD_FLIP_CUE_VOLUME },
  starAppear: { url: STAR_APPEAR_SOUND_URL, volume: STAR_CUE_VOLUME },
  starDisappear: { url: STAR_DISAPPEAR_SOUND_URL, volume: STAR_CUE_VOLUME },
});

function clampVolume(value, fallback = UI_SFX_DEFAULTS.volume) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function readStoredPreferences(storage) {
  if (!storage) return { ...UI_SFX_DEFAULTS };
  try {
    const stored = JSON.parse(storage.getItem(UI_SFX_PREFERENCE_KEY) || "{}");
    return {
      enabled: typeof stored.enabled === "boolean" ? stored.enabled : UI_SFX_DEFAULTS.enabled,
      volume: clampVolume(stored.volume),
    };
  } catch {
    return { ...UI_SFX_DEFAULTS };
  }
}

function defaultStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function defaultAudioContext() {
  if (typeof window === "undefined") return null;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  return AudioContext ? new AudioContext() : null;
}

async function defaultLoadAudio(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load UI sound: ${response.status}`);
  return response.arrayBuffer();
}

export function createUISFXService({
  createPlayer = createUISFX,
  storage = defaultStorage(),
  isClient = () => typeof window !== "undefined" && typeof document !== "undefined",
  createAudioContext = defaultAudioContext,
  loadAudio = defaultLoadAudio,
} = {}) {
  let preferences = readStoredPreferences(storage);
  let player = null;
  let unlocked = false;
  let disposing = null;
  let audioContext = null;
  let cardFlipPlayRun = 0;
  const sampleBuffers = new Map();
  const sampleLoads = new Map();
  const activeLoops = new Map();
  const activeOneShots = new Set();
  const subscribers = new Set();

  const persist = () => {
    try {
      storage?.setItem(UI_SFX_PREFERENCE_KEY, JSON.stringify(preferences));
    } catch {
      // Sound preferences are optional enhancement state; a blocked storage
      // backend must never break the reading experience.
    }
  };

  const notify = () => {
    const snapshot = { ...preferences };
    subscribers.forEach((subscriber) => subscriber(snapshot));
  };

  const ensureAudioContext = () => {
    if (!isClient()) return null;
    if (!audioContext) {
      try {
        audioContext = createAudioContext();
      } catch {
        audioContext = null;
      }
    }
    return audioContext;
  };

  const ensurePlayer = () => {
    if (!isClient()) return null;
    if (!player) {
      const context = ensureAudioContext();
      player = createPlayer({
        pack: UI_SFX_PACK,
        volume: preferences.volume,
        enabled: preferences.enabled,
        ...(context ? { context } : {}),
      });
    }
    return player;
  };

  const stopLoop = (key) => {
    const active = activeLoops.get(key);
    if (!active) return;
    active.handle?.stop();
    activeLoops.delete(key);
  };

  const stopAllLoops = () => {
    [...activeLoops.keys()].forEach(stopLoop);
  };

  const stopOneShots = () => {
    cardFlipPlayRun += 1;
    [...activeOneShots].forEach(({ source }) => {
      try { source.stop(); } catch {
        // A one-shot may already have ended between snapshot and stop().
      }
    });
    activeOneShots.clear();
  };

  const prepareOneShot = (key) => {
    const sample = ONE_SHOT_SAMPLES[key];
    if (!sample || !preferences.enabled) return null;
    const context = ensureAudioContext();
    if (!context) return null;

    // resume() is intentionally invoked before yielding: callers use this from
    // a trusted click/submit gesture so later automatic card reveals can play.
    const resumed = !["running", "closed"].includes(context.state)
      ? Promise.resolve(context.resume()).catch(() => null)
      : Promise.resolve();

    if (!sampleBuffers.has(key) && !sampleLoads.has(key)) {
      const loadingContext = context;
      const loading = Promise.resolve(loadAudio(sample.url))
        .then((bytes) => loadingContext.decodeAudioData(bytes))
        .then((buffer) => {
          if (audioContext === loadingContext) sampleBuffers.set(key, buffer);
          return buffer;
        })
        .catch(() => null);
      sampleLoads.set(key, loading);
      void loading.finally(() => {
        if (sampleLoads.get(key) === loading) sampleLoads.delete(key);
      });
    }

    return Promise.all([resumed, sampleBuffers.get(key) || sampleLoads.get(key)]);
  };

  const playPreparedOneShot = (key, { delayMs = 0 } = {}) => {
    const sample = ONE_SHOT_SAMPLES[key];
    const context = audioContext;
    const buffer = sampleBuffers.get(key);
    if (!sample || !preferences.enabled || !context || context.state !== "running" || !buffer) return null;
    try {
      const source = context.createBufferSource();
      const gain = context.createGain();
      const active = { source, gain, cueVolume: sample.volume };
      source.buffer = buffer;
      gain.gain.value = preferences.volume * sample.volume;
      source.connect(gain);
      gain.connect(context.destination);
      source.addEventListener?.("ended", () => {
        activeOneShots.delete(active);
        source.disconnect?.();
        gain.disconnect?.();
      }, { once: true });
      activeOneShots.add(active);
      source.start((context.currentTime || 0) + (Math.max(0, delayMs) / 1_000));
      return source;
    } catch {
      return null;
    }
  };

  const play = (cue, options) => {
    if (!unlocked || !preferences.enabled) return null;
    return ensurePlayer()?.play(cue, options) ?? null;
  };

  return {
    getPreferences() {
      return { ...preferences };
    },

    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },

    // Must be called synchronously from a trusted click/key handler. UISFX
    // creates and resumes its AudioContext inside play(), so no cue is queued
    // from page load or from an old async event.
    activate(cue, options) {
      if (!preferences.enabled) return null;
      const nextPlayer = ensurePlayer();
      if (!nextPlayer) return null;
      unlocked = true;
      return nextPlayer.play(cue, options) ?? null;
    },

    // Warm and unlock the supplied card-flip sample from a trusted gesture.
    // This does not play anything by itself.
    prepareCardFlip() {
      return prepareOneShot("cardFlip");
    },

    prepareStarSounds() {
      return Promise.all([
        prepareOneShot("starAppear"),
        prepareOneShot("starDisappear"),
      ]);
    },

    // Use for a flip that happens directly in the current trusted gesture.
    activateCardFlip() {
      if (!preferences.enabled) return null;
      const run = ++cardFlipPlayRun;
      const prepared = prepareOneShot("cardFlip");
      const immediate = playPreparedOneShot("cardFlip");
      if (immediate || !prepared) return immediate;
      void prepared.then(() => {
        if (run === cardFlipPlayRun) playPreparedOneShot("cardFlip");
      });
      return null;
    },

    // Use for a later automatic reveal. If the trusted-gesture warm-up did not
    // finish, suppress the cue instead of queueing stale feedback.
    playCardFlip() {
      return playPreparedOneShot("cardFlip");
    },

    playStarAppear(options) {
      return playPreparedOneShot("starAppear", options);
    },

    playStarDisappear(options) {
      return playPreparedOneShot("starDisappear", options);
    },

    play,

    startLoop(key, cue, options) {
      if (!LOOP_CUES.has(cue) || !unlocked || !preferences.enabled) return null;
      const existing = activeLoops.get(key);
      if (existing?.cue === cue) return existing.handle;
      stopLoop(key);
      const handle = play(cue, { ...options, loop: true, retrigger: "ignore" });
      if (!handle) return null;
      activeLoops.set(key, { cue, handle });
      void handle.ended.finally(() => {
        if (activeLoops.get(key)?.handle === handle) activeLoops.delete(key);
      });
      return handle;
    },

    stopLoop,
    stopAllLoops,

    setEnabled(enabled) {
      const next = Boolean(enabled);
      if (!next) {
        stopAllLoops();
        player?.stopAll();
        stopOneShots();
      }
      preferences = { ...preferences, enabled: next };
      persist();
      player?.setPack(UI_SFX_PACK);
      player?.setVolume(preferences.volume);
      player?.setEnabled(next);
      notify();
    },

    setVolume(volume) {
      preferences = { ...preferences, volume: clampVolume(volume, preferences.volume) };
      persist();
      player?.setPack(UI_SFX_PACK);
      player?.setVolume(preferences.volume);
      activeOneShots.forEach(({ gain, cueVolume }) => {
        const nextGain = preferences.volume * cueVolume;
        gain.gain.setValueAtTime?.(nextGain, audioContext?.currentTime || 0);
        if (!gain.gain.setValueAtTime) gain.gain.value = nextGain;
      });
      notify();
    },

    isUnlocked() {
      return unlocked;
    },

    async dispose() {
      if (disposing) return disposing;
      stopAllLoops();
      player?.stopAll();
      stopOneShots();
      const stalePlayer = player;
      const staleAudioContext = audioContext;
      player = null;
      audioContext = null;
      sampleBuffers.clear();
      sampleLoads.clear();
      unlocked = false;
      if (!stalePlayer && !staleAudioContext) return undefined;
      disposing = (async () => {
        try {
          await stalePlayer?.destroy();
        } finally {
          if (staleAudioContext?.state !== "closed") await staleAudioContext?.close?.();
        }
      })().finally(() => { disposing = null; });
      return disposing;
    },
  };
}

export const uiSfx = createUISFXService();

export async function runUISFXTask({
  key,
  task,
  service = uiSfx,
  loopCue = "processing",
  successCue = "success",
  errorCue = "error",
  isCancellation = (error) => error?.name === "AbortError",
}) {
  service.startLoop(key, loopCue);
  try {
    const result = await task();
    service.stopLoop(key);
    if (successCue) service.play(successCue);
    return result;
  } catch (error) {
    service.stopLoop(key);
    if (errorCue && !isCancellation(error)) service.play(errorCue);
    throw error;
  } finally {
    service.stopLoop(key);
  }
}

let lifecycleInstalled = false;

export function installUISFXLifecycle() {
  if (lifecycleInstalled || typeof window === "undefined" || typeof document === "undefined") return () => {};
  lifecycleInstalled = true;

  const handleVisibility = () => {
    if (document.hidden) uiSfx.stopAllLoops();
  };
  const handlePageHide = () => { void uiSfx.dispose(); };

  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("pagehide", handlePageHide, { once: true });

  return () => {
    lifecycleInstalled = false;
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener("pagehide", handlePageHide);
    void uiSfx.dispose();
  };
}
