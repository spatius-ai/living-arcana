export const BACKGROUND_MUSIC_TRACKS = Object.freeze([
  "/assets/audio/ambient-archive-01.mp3",
  "/assets/audio/ambient-archive-02.mp3",
]);

export const BACKGROUND_MUSIC_PREFERENCE_KEY = "living-arcana.background-music.v1";
export const BACKGROUND_MUSIC_DEFAULTS = Object.freeze({ enabled: true, volume: 0.12 });
export const BACKGROUND_MUSIC_SPEECH_DUCK = 0.28;
export const BACKGROUND_MUSIC_RECORDING_DUCK = 0.08;

function clampVolume(value, fallback = BACKGROUND_MUSIC_DEFAULTS.volume) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function defaultStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStoredPreferences(storage) {
  if (!storage) return { ...BACKGROUND_MUSIC_DEFAULTS };
  try {
    const stored = JSON.parse(storage.getItem(BACKGROUND_MUSIC_PREFERENCE_KEY) || "{}");
    return {
      enabled: typeof stored.enabled === "boolean" ? stored.enabled : BACKGROUND_MUSIC_DEFAULTS.enabled,
      volume: clampVolume(stored.volume),
    };
  } catch {
    return { ...BACKGROUND_MUSIC_DEFAULTS };
  }
}

function defaultCreateAudio(src) {
  if (typeof Audio === "undefined") return null;
  return new Audio(src);
}

function defaultRequestFrame(callback) {
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    return window.requestAnimationFrame(callback);
  }
  callback(Date.now());
  return 0;
}

function defaultCancelFrame(frame) {
  if (typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(frame);
  }
}

function defaultNow() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function createBackgroundMusicService({
  sources = BACKGROUND_MUSIC_TRACKS,
  storage = defaultStorage(),
  isClient = () => typeof window !== "undefined" && typeof document !== "undefined",
  createAudio = defaultCreateAudio,
  requestFrame = defaultRequestFrame,
  cancelFrame = defaultCancelFrame,
  now = defaultNow,
} = {}) {
  let preferences = readStoredPreferences(storage);
  let tracks = [];
  let currentIndex = 0;
  let playing = false;
  let fadeFrame = null;
  const duckers = new Map();
  const subscribers = new Set();

  const snapshot = () => ({
    ...preferences,
    playing,
    currentTrack: currentIndex,
    ducked: duckers.size > 0,
  });

  const notify = () => {
    const next = snapshot();
    subscribers.forEach((subscriber) => subscriber(next));
  };

  const persist = () => {
    try {
      storage?.setItem(BACKGROUND_MUSIC_PREFERENCE_KEY, JSON.stringify(preferences));
    } catch {
      // Background music is optional; blocked storage must not affect the app.
    }
  };

  const setPlaying = (next) => {
    if (playing === next) return;
    playing = next;
    notify();
  };

  const targetVolume = () => {
    const duck = duckers.size ? Math.min(...duckers.values()) : 1;
    return clampVolume(preferences.volume * duck, 0);
  };

  const cancelVolumeFade = () => {
    if (fadeFrame === null) return;
    cancelFrame(fadeFrame);
    fadeFrame = null;
  };

  const applyTargetVolume = ({ immediate = false } = {}) => {
    if (!tracks.length) return;
    cancelVolumeFade();
    const target = targetVolume();
    if (immediate) {
      tracks.forEach(({ audio }) => { audio.volume = target; });
      return;
    }

    const from = tracks.map(({ audio }) => audio.volume);
    const startedAt = now();
    const duration = duckers.size ? 320 : 520;
    const step = (timestamp) => {
      const progress = Math.min(1, Math.max(0, (timestamp - startedAt) / duration));
      const eased = 1 - ((1 - progress) ** 3);
      tracks.forEach(({ audio }, index) => {
        audio.volume = from[index] + ((target - from[index]) * eased);
      });
      if (progress < 1) fadeFrame = requestFrame(step);
      else fadeFrame = null;
    };
    fadeFrame = requestFrame(step);
  };

  const playCurrent = () => {
    if (!preferences.enabled) return null;
    const active = tracks[currentIndex]?.audio;
    if (!active) return null;
    tracks.forEach(({ audio }, index) => {
      if (index !== currentIndex && !audio.paused) audio.pause();
    });
    try {
      const result = active.play();
      setPlaying(true);
      void Promise.resolve(result).catch(() => setPlaying(false));
      return result;
    } catch {
      setPlaying(false);
      return null;
    }
  };

  const advance = (index) => {
    if (!preferences.enabled || index !== currentIndex || !tracks.length) return;
    tracks[index].audio.currentTime = 0;
    currentIndex = (currentIndex + 1) % tracks.length;
    playCurrent();
  };

  const ensureTracks = () => {
    if (!isClient() || tracks.length) return tracks;
    tracks = sources.map((src, index) => {
      const audio = createAudio(src);
      if (!audio) return null;
      // Only the track about to play buffers up front; the others (~1.9 MB
      // each) load when play() reaches them instead of all at boot.
      audio.preload = index === currentIndex ? "auto" : "none";
      audio.loop = false;
      const handleEnded = () => advance(index);
      audio.addEventListener?.("ended", handleEnded);
      return { audio, handleEnded };
    }).filter(Boolean);
    applyTargetVolume({ immediate: true });
    return tracks;
  };

  return {
    getPreferences: snapshot,

    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },

    setEnabled(enabled) {
      const next = Boolean(enabled);
      preferences = { ...preferences, enabled: next };
      persist();
      if (next) {
        ensureTracks();
        playCurrent();
      } else {
        cancelVolumeFade();
        tracks.forEach(({ audio }) => audio.pause());
        setPlaying(false);
      }
      notify();
    },

    setVolume(volume) {
      preferences = { ...preferences, volume: clampVolume(volume, preferences.volume) };
      persist();
      applyTargetVolume();
      notify();
    },

    setDucked(key, ducked, factor = BACKGROUND_MUSIC_SPEECH_DUCK) {
      if (!key) return;
      if (ducked) duckers.set(key, clampVolume(factor, BACKGROUND_MUSIC_SPEECH_DUCK));
      else duckers.delete(key);
      applyTargetVolume();
      notify();
    },

    resume() {
      if (!preferences.enabled) return null;
      ensureTracks();
      return playCurrent();
    },

    pause() {
      cancelVolumeFade();
      tracks.forEach(({ audio }) => audio.pause());
      setPlaying(false);
    },

    isPlaying() {
      return playing;
    },

    dispose() {
      cancelVolumeFade();
      tracks.forEach(({ audio, handleEnded }) => {
        audio.pause();
        audio.removeEventListener?.("ended", handleEnded);
        audio.removeAttribute?.("src");
        audio.load?.();
      });
      tracks = [];
      currentIndex = 0;
      setPlaying(false);
    },
  };
}

export const backgroundMusic = createBackgroundMusicService();

export function bindBackgroundMusicDucking(root, service = backgroundMusic, {
  Observer = globalThis.MutationObserver,
} = {}) {
  if (!root || !Observer) return () => {};
  const key = "spoken-reading";
  const sync = () => service.setDucked(key, root.dataset.speaking === "true", BACKGROUND_MUSIC_SPEECH_DUCK);
  const observer = new Observer(sync);
  sync();
  observer.observe(root, { attributes: true, attributeFilter: ["data-speaking"] });
  return () => {
    observer.disconnect();
    service.setDucked(key, false);
  };
}

let lifecycleInstalled = false;

export function installBackgroundMusicLifecycle(service = backgroundMusic) {
  if (lifecycleInstalled || typeof window === "undefined" || typeof document === "undefined") return () => {};
  lifecycleInstalled = true;
  let pausedForVisibility = false;

  const resumePersistedMusic = () => {
    if (service.getPreferences().enabled && !service.isPlaying()) service.resume();
  };
  const handleVisibility = () => {
    if (document.hidden) {
      pausedForVisibility = service.isPlaying();
      service.pause();
    } else if (pausedForVisibility) {
      pausedForVisibility = false;
      service.resume();
    }
  };
  const handlePageHide = () => service.dispose();

  document.addEventListener("pointerdown", resumePersistedMusic, true);
  document.addEventListener("keydown", resumePersistedMusic, true);
  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("pagehide", handlePageHide, { once: true });
  resumePersistedMusic();

  return () => {
    lifecycleInstalled = false;
    document.removeEventListener("pointerdown", resumePersistedMusic, true);
    document.removeEventListener("keydown", resumePersistedMusic, true);
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener("pagehide", handlePageHide);
    service.dispose();
  };
}
