import { splitPcmFrames } from "./pcmFrames.js";

const CONNECTION_TIMEOUT_MS = 20_000;
const FIRST_RENDER_TIMEOUT_MS = 30_000;
const AUDIO_UNLOCK_TIMEOUT_MS = 4_000;
const activeAdapters = new Set();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    activeAdapters.forEach((adapter) => adapter.dispose());
    activeAdapters.clear();
  });
}

const statusLabels = Object.freeze({
  idle: "Preview",
  loading: "Awakening",
  connecting: "Connecting",
  ready: "Live",
  error: "Unavailable",
});

function nextFrame() {
  return new Promise((resolve) => window.requestAnimationFrame(resolve));
}

async function waitForLayout(element) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const bounds = element.getBoundingClientRect();
    if (bounds.width > 0 && bounds.height > 0) return;
    await nextFrame();
  }
  throw new Error("The avatar render target has no visible size.");
}

export function createSpatiusDirectAdapter({
  appId,
  avatarId,
  region = "ap-northeast",
  tokenEndpoint = "/api/spatius/session-token",
  readingEndpoint = "/api/arcana/ask",
  speechEndpoint = "/api/arcana/speak",
  sampleAudioUrl = "/assets/audio/daily-note-01.pcm",
}) {
  let root = null;
  let readingTarget = null;
  let stage = null;
  let sdk = null;
  let avatarView = null;
  let controller = null;
  let sdkInitializationPromise = null;
  let preparationPromise = null;
  let connectionPromise = null;
  let connectionState = "disconnected";
  let sdkInitialized = false;
  let cachedSessionToken = null;
  let cachedSessionExpiresAt = 0;
  let sampleAudioPromise = null;
  let audioUnlocked = false;
  let audioPermissionGranted = false;
  let audioUnlockPromise = null;
  let disposed = false;
  let playbackResolve = null;
  let playbackStarted = false;
  let playbackTimer = 0;
  let speechAbortController = null;
  let duplexPcmRemainder = new Uint8Array(0);
  let speechReader = null;
  let speechRequestId = 0;
  let visibilityHandler = null;
  let avatarTransform = { x: 0, y: -0.08, scale: 1.32 };
  let firstFrameRendered = false;
  let desiredAvatarId = avatarId;
  let loadedAvatarId = null;
  let avatarSwitchPromise = Promise.resolve();

  const setStatus = (status) => {
    if (root) {
      root.dataset.spatiusStatus = status;
      if (status !== "error") delete root.dataset.spatiusError;
    }
    root?.querySelectorAll("[data-spatius-label]").forEach((label) => {
      label.textContent = statusLabels[status] || statusLabels.idle;
    });
  };

  const settlePlayback = (result) => {
    window.clearTimeout(playbackTimer);
    playbackTimer = 0;
    const resolve = playbackResolve;
    playbackResolve = null;
    playbackStarted = false;
    resolve?.(result);
  };

  const cancelSpeechStream = () => {
    speechRequestId += 1;
    const abortController = speechAbortController;
    const reader = speechReader;
    speechAbortController = null;
    speechReader = null;
    abortController?.abort();
    reader?.cancel().catch(() => {});
  };

  const ensureStage = () => {
    if (!readingTarget?.isConnected) {
      readingTarget = root?.querySelector('[data-spatius-host="reading"]') || null;
    }
    if (!readingTarget) throw new Error("The Spatius reading target is unavailable.");

    if (!stage) {
      stage = document.createElement("span");
      stage.className = "spatius-avatar-stage";
      stage.setAttribute("aria-hidden", "true");
    }

    // AvatarView changes its container to `position: relative`. The same
    // stage is intentionally moved between Today, the three-card prewarmer,
    // and the visible spotlight, so preserve explicit dimensions even after
    // the previous canvas has been disposed.
    stage.style.position = "absolute";
    stage.style.inset = "0";
    stage.style.width = "100%";
    stage.style.height = "100%";

    // React can remove imperatively appended children while reconciling the
    // card after a character switch. Reattach the existing AvatarKit stage
    // before measuring it instead of keeping a detached, zero-sized node.
    if (stage.parentElement !== readingTarget) readingTarget.append(stage);
    return stage;
  };

  const loadSampleAudio = () => {
    if (!sampleAudioPromise) {
      sampleAudioPromise = fetch(sampleAudioUrl, { cache: "force-cache" }).then(async (response) => {
        if (!response.ok) throw new Error(`Avatar sample audio failed to load (${response.status}).`);
        return response.arrayBuffer();
      });
    }
    return sampleAudioPromise;
  };

  const releaseConnection = ({ updateStatus = true } = {}) => {
    cancelSpeechStream();
    connectionPromise = null;
    connectionState = sdk?.ConnectionState.disconnected || "disconnected";
    controller?.interrupt();
    controller?.close();
    if (root) root.dataset.speaking = "false";
    settlePlayback({ completed: false, interrupted: true });
    if (updateStatus && avatarView) setStatus("ready");
  };

  const updateAvatarTransform = (payload = {}, applyToView = true) => {
    avatarTransform = {
      x: Number.isFinite(payload.x) ? Math.min(1, Math.max(-1, payload.x)) : avatarTransform.x,
      y: Number.isFinite(payload.y) ? Math.min(1, Math.max(-1, payload.y)) : avatarTransform.y,
      scale: Number.isFinite(payload.scale) ? Math.min(3, Math.max(0.5, payload.scale)) : avatarTransform.scale,
    };
    if (applyToView && firstFrameRendered && avatarView?.isRenderingEnabled()) avatarView.avatarTransform = avatarTransform;
    return avatarTransform;
  };

  const ensureSdkInitialized = () => {
    if (sdkInitialized && sdk) return Promise.resolve(sdk);
    if (sdkInitializationPromise) return sdkInitializationPromise;

    sdkInitializationPromise = (async () => {
      sdk = await import("@spatius/avatarkit");
      await sdk.AvatarSDK.initialize(appId, {
        region,
        drivingServiceMode: sdk.DrivingServiceMode.direct,
        logLevel: sdk.LogLevel.warning,
        renderQuality: sdk.RenderQuality.high,
      });
      sdk.AvatarSDK.setRenderResolutionCap(true, 720);
      sdkInitialized = true;
      return sdk;
    })().catch((error) => {
      sdkInitializationPromise = null;
      throw error;
    });

    return sdkInitializationPromise;
  };

  // unlock()/startDuplex() are called from a tap, but they await prepare()
  // before reaching ensureAudioUnlocked(); by then iOS no longer treats the
  // call as user-initiated. Start the unlock synchronously when the controller
  // already exists — the awaited call below joins the same promise.
  const unlockWithinGesture = () => {
    if (controller && !audioUnlocked) void ensureAudioUnlocked().catch(() => {});
  };

  const teardownAvatarView = () => {
    releaseConnection({ updateStatus: false });
    firstFrameRendered = false;
    avatarView?.dispose();
    stage?.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
    stage?.removeAttribute("data-ready");
    readingTarget?.removeAttribute("data-spatius-rendered");
    avatarView = null;
    controller = null;
    loadedAvatarId = null;
    preparationPromise = null;
    audioUnlocked = false;
    audioUnlockPromise = null;
  };

  const prepare = (payload = {}) => {
    if (disposed) return Promise.reject(new Error("The Spatius adapter has been disposed."));
    if (payload.transform) updateAvatarTransform(payload.transform, false);
    const requestedAvatarId = typeof payload.avatarId === "string" ? payload.avatarId.trim() : "";
    if (requestedAvatarId && requestedAvatarId !== desiredAvatarId) return switchAvatar(payload);
    if (preparationPromise) return preparationPromise;

    preparationPromise = (async () => {
      if (!appId || !desiredAvatarId) throw new Error("Spatius App ID or Avatar ID is missing.");
      setStatus("loading");

      await ensureSdkInitialized();
      const renderStage = ensureStage();
      await waitForLayout(renderStage);

      const avatarBeingLoaded = desiredAvatarId;
      const avatar = await sdk.AvatarManager.shared.load(avatarBeingLoaded, undefined, true);
      if (disposed) return false;

      avatarView = new sdk.AvatarView(avatar, renderStage, {
        audioFormat: {
          channelCount: 1,
          sampleRate: 16_000,
          opusUplinkEnabled: true,
        },
      });
      controller = avatarView.controller;
      loadedAvatarId = avatarBeingLoaded;
      firstFrameRendered = false;

      const firstRender = new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          reject(new Error("The avatar did not render its first frame in time."));
        }, FIRST_RENDER_TIMEOUT_MS);

        avatarView.onFirstRendering = () => {
          window.clearTimeout(timeout);
          try {
            firstFrameRendered = true;
            avatarView.avatarTransform = avatarTransform;
            readingTarget?.setAttribute("data-spatius-rendered", "");
            renderStage.setAttribute("data-ready", "");
            resolve(true);
          } catch (error) {
            firstFrameRendered = false;
            reject(error);
          }
        };
      });

      controller.onConnectionState = (state) => {
        connectionState = state;
        if (state === sdk.ConnectionState.connecting) setStatus("connecting");
        if (state === sdk.ConnectionState.connected) setStatus("ready");
        if (state === sdk.ConnectionState.failed) setStatus("error");
      };

      controller.onConversationState = (state) => {
        if (state === sdk.ConversationState.playing) {
          playbackStarted = true;
          if (root) root.dataset.speaking = "true";
        }
        if (state === sdk.ConversationState.idle && playbackStarted) {
          if (root) root.dataset.speaking = "false";
          settlePlayback({ completed: true });
        }
      };

      controller.onError = (error) => {
        if ([sdk.ErrorCode.sessionTokenExpired, sdk.ErrorCode.sessionTokenInvalid].includes(error.code)) {
          connectionPromise = null;
          connectionState = sdk.ConnectionState.disconnected;
          cachedSessionToken = null;
          cachedSessionExpiresAt = 0;
        }
        if (playbackResolve) settlePlayback({ completed: false, error: true });
        console.error(`[Living Arcana] Spatius error (${error.code || "unknown"}):`, error.message);
        setStatus("error");
      };

      void loadSampleAudio();
      await firstRender;
      if (audioPermissionGranted) {
        try {
          await controller.initializeAudioContext();
          audioUnlocked = true;
        } catch {
          audioUnlocked = false;
        }
      }
      setStatus("ready");
      return true;
    })().catch((error) => {
      firstFrameRendered = false;
      avatarView?.dispose();
      avatarView = null;
      controller = null;
      loadedAvatarId = null;
      stage?.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
      preparationPromise = null;
      console.error("[Living Arcana] Spatius avatar preparation failed:", error);
      if (root) root.dataset.spatiusError = error?.message || "Avatar preparation failed.";
      setStatus("error");
      throw error;
    });

    return preparationPromise;
  };

  const switchAvatar = (payload = {}) => {
    const requestedAvatarId = typeof payload.avatarId === "string" ? payload.avatarId.trim() : "";
    if (requestedAvatarId) desiredAvatarId = requestedAvatarId;
    if (payload.transform) updateAvatarTransform(payload.transform);
    if (!readingTarget) return Promise.resolve({ avatarId: desiredAvatarId, transform: avatarTransform });
    if (loadedAvatarId === desiredAvatarId && avatarView) return Promise.resolve({ avatarId: loadedAvatarId, transform: avatarTransform });

    avatarSwitchPromise = avatarSwitchPromise.catch(() => {}).then(async () => {
      if (preparationPromise) await preparationPromise.catch(() => {});
      if (loadedAvatarId === desiredAvatarId && avatarView) return { avatarId: loadedAvatarId, transform: avatarTransform };
      teardownAvatarView();
      await prepare();
      return { avatarId: loadedAvatarId, transform: avatarTransform };
    });
    return avatarSwitchPromise;
  };

  const ensureConnected = async () => {
    await prepare();
    if (connectionState === sdk.ConnectionState.connected) return true;
    if (connectionPromise) return connectionPromise;

    connectionPromise = (async () => {
      const now = Math.floor(Date.now() / 1000);
      if (!cachedSessionToken || cachedSessionExpiresAt <= now + 30) {
        const response = await fetch(tokenEndpoint, {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`Avatar session endpoint failed (${response.status}).`);

        const payload = await response.json();
        if (!payload.sessionToken) throw new Error("Avatar session endpoint returned no token.");
        cachedSessionToken = payload.sessionToken;
        cachedSessionExpiresAt = Number(payload.expiresAt) || now + (15 * 60);
      }
      sdk.AvatarSDK.setSessionToken(cachedSessionToken);

      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("Avatar connection timed out.")), CONNECTION_TIMEOUT_MS);
        const previousHandler = controller.onConnectionState;

        controller.onConnectionState = (state) => {
          previousHandler?.(state);
          if (state === sdk.ConnectionState.connected) {
            window.clearTimeout(timeout);
            resolve(true);
          } else if (state === sdk.ConnectionState.failed) {
            window.clearTimeout(timeout);
            reject(new Error("Avatar connection failed."));
          }
        };

        controller.start().catch((error) => {
          window.clearTimeout(timeout);
          reject(error);
        });
      });
    })().catch((error) => {
      connectionPromise = null;
      if (root) root.dataset.spatiusError = error?.message || "Avatar connection failed.";
      setStatus("error");
      throw error;
    });

    return connectionPromise;
  };

  const ensureAudioUnlocked = () => {
    if (audioUnlocked) return Promise.resolve(true);
    if (!audioPermissionGranted) return Promise.reject(new Error("Avatar audio has not been unlocked by a user gesture."));
    if (audioUnlockPromise) return audioUnlockPromise;

    // Outside a user gesture iOS leaves AudioContext.resume() pending forever
    // — no rejection — which used to hang unlock()/startDuplex() with it. Time
    // out instead, so the caller reports it and the next tap can retry.
    let unlockTimer = 0;
    const unlockTimeout = new Promise((_, reject) => {
      unlockTimer = window.setTimeout(() => reject(new Error("Avatar audio could not be unlocked.")), AUDIO_UNLOCK_TIMEOUT_MS);
    });
    audioUnlockPromise = Promise.race([Promise.resolve(controller?.initializeAudioContext()), unlockTimeout])
      .finally(() => window.clearTimeout(unlockTimer))
      .then(() => {
        audioUnlocked = true;
        return true;
      })
      .catch((error) => {
        audioUnlockPromise = null;
        throw error;
      });
    return audioUnlockPromise;
  };

  const adapter = {
    mount(payload = {}) {
      root = payload.root || root;
      readingTarget = payload.readingTarget || readingTarget;
      ensureStage();
      if (!visibilityHandler) {
        visibilityHandler = () => {
          if (document.hidden) releaseConnection({ updateStatus: false });
        };
        document.addEventListener("visibilitychange", visibilityHandler);
      }
      setStatus("idle");
    },
    async preload(payload = {}) {
      if (disposed) return [];
      const avatarIds = [...new Set((payload.avatarIds || [])
        .filter((id) => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean))];
      if (!avatarIds.length || !appId) return [];

      // AvatarSDK.initialize exposes no byte progress, so it is reported as one
      // fixed step. It dominates a cold visit: besides the SDK + WASM (~2.3 MB)
      // it fetches the shared body model (~29 MB, cached by the SDK afterwards),
      // while one avatar's own assets are only a few MB. The rest tracks
      // AvatarManager's per-avatar download. Same `load` arguments as
      // prepare(), so the later prepare() reuses these cached assets.
      const SDK_SHARE = 0.7;
      const onProgress = typeof payload.onProgress === "function" ? payload.onProgress : null;
      const fractions = avatarIds.map(() => 0);
      const report = () => {
        const assets = fractions.reduce((sum, value) => sum + value, 0) / fractions.length;
        onProgress?.(SDK_SHARE + (1 - SDK_SHARE) * assets);
      };

      // Ease toward the SDK share while initialize runs so the boot counter
      // keeps moving through a download it cannot measure.
      const initStartedAt = performance.now();
      const initCreep = onProgress ? window.setInterval(() => {
        onProgress(SDK_SHARE * 0.92 * (1 - Math.exp(-(performance.now() - initStartedAt) / 9000)));
      }, 250) : 0;
      onProgress?.(0);
      try {
        await ensureSdkInitialized();
      } finally {
        window.clearInterval(initCreep);
      }
      report();
      const results = await Promise.allSettled(avatarIds.map((id, index) => (
        sdk.AvatarManager.shared.load(id, (info) => {
          if (!Number.isFinite(info?.progress)) return;
          fractions[index] = Math.max(fractions[index], Math.min(1, info.progress));
          report();
        }, true).then((avatar) => {
          fractions[index] = 1;
          report();
          return avatar;
        })
      )));
      return results.map((result, index) => ({ avatarId: avatarIds[index], ready: result.status === "fulfilled" }));
    },
    prepare,
    async unlock(payload = {}) {
      audioPermissionGranted = true;
      unlockWithinGesture();
      await prepare(payload);
      await Promise.all([ensureAudioUnlocked(), ensureConnected()]);
      return true;
    },
    async play(payload = {}) {
      await prepare(payload);
      if (!audioUnlocked) throw new Error("Avatar audio has not been unlocked by a user gesture.");
      await ensureConnected();

      const audio = await loadSampleAudio();
      if (!audio.byteLength) throw new Error("Avatar sample audio is empty.");
      if (playbackResolve) {
        controller.interrupt();
        settlePlayback({ completed: false, interrupted: true });
      }

      const playbackDone = new Promise((resolve) => {
        playbackResolve = resolve;
      });
      playbackTimer = window.setTimeout(() => {
        if (root) root.dataset.speaking = "false";
        settlePlayback({ completed: false, timedOut: true });
      }, 20_000);
      controller.send(audio.slice(0), true);
      return playbackDone;
    },
    async ask(payload = {}) {
      const question = typeof payload.question === "string" ? payload.question.trim() : "";
      if (!question) throw new Error("A question is required.");
      const dailyTurnId = typeof payload.dailyTurnId === "string" && payload.dailyTurnId.trim()
        ? payload.dailyTurnId.trim()
        : globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const response = await fetch(readingEndpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          cardId: payload.cardId,
          question,
          voice: payload.voice === true,
          dailyTurnId,
          history: Array.isArray(payload.history) ? payload.history : [],
        }),
      });
      if (!response.ok) throw new Error(`Arcana reading endpoint failed (${response.status}).`);
      return response.json();
    },
    async speak(payload = {}) {
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (!text) throw new Error("Speech text is required.");
      const reportPcmProgress = (byteLength, last, totalBytes) => {
        if (typeof payload.onPcm !== "function") return;
        try {
          payload.onPcm({ byteLength, last, totalBytes });
        } catch (error) {
          // Subtitle/progress observers must never be able to interrupt voice
          // playback. Keep the failure diagnostic-only.
          console.warn("[Living Arcana] Speech progress observer failed:", error);
        }
      };
      await prepare(payload);
      await Promise.all([ensureAudioUnlocked(), ensureConnected()]);

      cancelSpeechStream();
      if (playbackResolve) {
        controller.interrupt();
        settlePlayback({ completed: false, interrupted: true });
      }
      const requestId = ++speechRequestId;
      const abortController = new AbortController();
      speechAbortController = abortController;
      let reader = null;

      try {
        const response = await fetch(speechEndpoint, {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "audio/pcm", "Content-Type": "application/json" },
          body: JSON.stringify({
            cardId: payload.cardId,
            text,
            voiceId: payload.voiceId,
            voiceSettings: payload.voiceSettings,
          }),
          signal: abortController.signal,
        });
        if (!response.ok || !response.body) throw new Error(`Arcana speech endpoint failed (${response.status}).`);
        if (requestId !== speechRequestId) {
          response.body.cancel().catch(() => {});
          return { completed: false, interrupted: true };
        }

        const playbackDone = new Promise((resolve) => {
          playbackResolve = resolve;
        });
        playbackTimer = window.setTimeout(() => {
          if (root) root.dataset.speaking = "false";
          settlePlayback({ completed: false, timedOut: true });
        }, 45_000);

        reader = response.body.getReader();
        speechReader = reader;
        let buffered = new Uint8Array(0);
        let sentBytes = 0;
        if (root) root.dataset.speaking = "true";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (requestId !== speechRequestId) return { completed: false, interrupted: true };
          if (!value?.byteLength) continue;
          const merged = new Uint8Array(buffered.byteLength + value.byteLength);
          merged.set(buffered);
          merged.set(value, buffered.byteLength);
          const evenLength = merged.byteLength - (merged.byteLength % 2);
          const sendLength = evenLength > 2 ? evenLength - 2 : 0;
          if (sendLength) {
            controller.send(merged.buffer.slice(0, sendLength), false);
            sentBytes += sendLength;
            reportPcmProgress(sendLength, false, sentBytes);
          }
          buffered = merged.slice(sendLength);
        }

        if (requestId !== speechRequestId) return { completed: false, interrupted: true };
        const finalLength = buffered.byteLength - (buffered.byteLength % 2);
        if (!finalLength && !sentBytes) throw new Error("The TTS provider returned no PCM audio.");
        controller.send(buffered.buffer.slice(buffered.byteOffset, buffered.byteOffset + finalLength), true);
        sentBytes += finalLength;
        reportPcmProgress(finalLength, true, sentBytes);
        return playbackDone;
      } catch (error) {
        reader?.cancel().catch(() => {});
        if (error?.name === "AbortError" || requestId !== speechRequestId) {
          return { completed: false, interrupted: true };
        }
        if (root) root.dataset.speaking = "false";
        settlePlayback({ completed: false, error: true });
        throw error;
      } finally {
        if (speechAbortController === abortController) speechAbortController = null;
        if (speechReader === reader) speechReader = null;
      }
    },
    // Duplex support: an external realtime source (the ElevenLabs Agents
    // WebSocket) streams 16 kHz mono s16le PCM chunks straight into the
    // avatar's lip-sync channel. `startDuplex` must be triggered by a user
    // gesture (it unlocks audio); `streamPcm` is called at chunk frequency and
    // must stay cheap; `last: true` closes the current utterance so the mouth
    // returns to idle.
    async startDuplex(payload = {}) {
      audioPermissionGranted = true;
      unlockWithinGesture();
      await prepare(payload);
      await Promise.all([ensureAudioUnlocked(), ensureConnected()]);
      cancelSpeechStream();
      duplexPcmRemainder = new Uint8Array(0);
      if (playbackResolve) {
        controller.interrupt();
        settlePlayback({ completed: false, interrupted: true });
      }
      return true;
    },
    streamPcm(payload = {}) {
      if (disposed || !controller || !audioUnlocked) return false;
      if (connectionState !== sdk?.ConnectionState.connected) return false;
      // Frame alignment (odd-byte carry) lives in splitPcmFrames — see the
      // warning there before changing anything about this path.
      const incoming = payload.chunk instanceof ArrayBuffer ? new Uint8Array(payload.chunk) : new Uint8Array(0);
      const { send, remainder } = splitPcmFrames(duplexPcmRemainder, incoming, Boolean(payload.last));
      duplexPcmRemainder = remainder;
      if (payload.last) {
        controller.send(send, true);
        return true;
      }
      if (send) controller.send(send, false);
      return true;
    },
    interruptSpeech() {
      if (!controller) return;
      // Barge-in: cancel any in-flight TTS stream AND cut current playback so
      // the avatar falls silent immediately when the user starts talking.
      cancelSpeechStream();
      duplexPcmRemainder = new Uint8Array(0);
      controller.interrupt();
      if (root) root.dataset.speaking = "false";
      settlePlayback({ completed: false, interrupted: true });
    },
    setAvatar(payload = {}) {
      return switchAvatar(payload);
    },
    setTransform(payload = {}) {
      return updateAvatarTransform(payload);
    },
    stop() {
      releaseConnection();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (visibilityHandler) document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = null;
      releaseConnection({ updateStatus: false });
      avatarView?.dispose();
      sdk?.AvatarSDK.cleanup();
      sdkInitialized = false;
      sdkInitializationPromise = null;
      cachedSessionToken = null;
      cachedSessionExpiresAt = 0;
      audioUnlockPromise = null;
      firstFrameRendered = false;
      stage?.remove();
      avatarView = null;
      controller = null;
      stage = null;
      activeAdapters.delete(adapter);
    },
  };

  activeAdapters.add(adapter);
  return adapter;
}
