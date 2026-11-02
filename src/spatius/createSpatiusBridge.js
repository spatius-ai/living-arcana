const INITIAL_STATE = Object.freeze({ status: "idle", error: null });

export function createSpatiusBridge(resolveAdapter = () => window.SPATIUS_ADAPTER) {
  let state = INITIAL_STATE;
  let disposed = false;
  const subscribers = new Set();

  const publish = (next) => {
    state = Object.freeze({ ...state, ...next });
    subscribers.forEach((subscriber) => subscriber(state));
  };

  const call = async (method, payload) => {
    if (disposed) return undefined;
    const adapter = resolveAdapter?.();
    const operation = adapter?.[method];
    if (typeof operation !== "function") return undefined;

    try {
      publish({ status: method === "stop" ? "stopping" : method, error: null });
      const result = await operation.call(adapter, payload);
      if (!disposed) publish({ status: method === "stop" ? "idle" : "ready", error: null });
      return result;
    } catch (error) {
      if (!disposed) publish({ status: "error", error });
      throw error;
    }
  };

  return {
    mount: (payload) => call("mount", payload),
    preload: (payload) => call("preload", payload),
    prepare: (payload) => call("prepare", payload),
    unlock: (payload) => call("unlock", payload),
    play: (payload) => call("play", payload),
    ask: (payload) => call("ask", payload),
    speak: (payload) => call("speak", payload),
    setMicrophone: (payload) => call("setMicrophone", payload),
    startDuplex: (payload) => call("startDuplex", payload),
    // High-frequency, latency-sensitive calls bypass status publishing.
    streamPcm: (payload) => resolveAdapter?.()?.streamPcm?.(payload),
    interruptSpeech: (payload) => resolveAdapter?.()?.interruptSpeech?.(payload),
    setAvatar: (payload) => call("setAvatar", payload),
    setTransform: (payload) => call("setTransform", payload),
    stop: (payload) => call("stop", payload),
    getSnapshot: () => state,
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    dispose() {
      if (disposed) return;
      const adapter = resolveAdapter?.();
      disposed = true;
      subscribers.clear();
      Promise.resolve(adapter?.dispose?.()).catch(() => {});
    },
  };
}
