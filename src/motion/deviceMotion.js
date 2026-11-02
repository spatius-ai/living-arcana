export const MOTION_POSE_EVENT = "living-arcana:motion-pose";
export const MOTION_PREFERENCE_KEY = "living-arcana.motion.v1";

const MAX_SENSOR_ANGLE = 14;
const BACKGROUND_X_PX = 10;
const BACKGROUND_Y_PX = 7;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function readPreference(storage) {
  try {
    return storage?.getItem(MOTION_PREFERENCE_KEY) === "true";
  } catch {
    return false;
  }
}

function defaultStorage() {
  try {
    return globalThis.window?.localStorage ?? null;
  } catch {
    return null;
  }
}

function readScreenAngle(windowTarget) {
  const angle = windowTarget?.screen?.orientation?.angle;
  if (Number.isFinite(angle)) return ((angle % 360) + 360) % 360;
  const legacy = windowTarget?.orientation;
  return Number.isFinite(legacy) ? ((legacy % 360) + 360) % 360 : 0;
}

export function normalizeDeviceOrientation(
  { beta, gamma },
  baseline,
  screenAngle = 0,
  maxAngle = MAX_SENSOR_ANGLE,
) {
  if (!Number.isFinite(beta) || !Number.isFinite(gamma) || !baseline) return null;
  const deltaBeta = beta - baseline.beta;
  const deltaGamma = gamma - baseline.gamma;
  let horizontal = deltaGamma;
  let vertical = deltaBeta;

  if (screenAngle === 90) {
    horizontal = deltaBeta;
    vertical = -deltaGamma;
  } else if (screenAngle === 180) {
    horizontal = -deltaGamma;
    vertical = -deltaBeta;
  } else if (screenAngle === 270) {
    horizontal = -deltaBeta;
    vertical = deltaGamma;
  }

  return {
    x: clamp(horizontal / maxAngle, -1, 1),
    y: clamp(vertical / maxAngle, -1, 1),
  };
}

export function createDeviceMotionService({
  windowTarget = globalThis.window,
  documentTarget = globalThis.document,
  storage = defaultStorage(),
  requestFrame = (callback) => windowTarget.requestAnimationFrame(callback),
  cancelFrame = (frame) => windowTarget.cancelAnimationFrame(frame),
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  let root = null;
  let ambient = null;
  let mounted = false;
  let orientationListening = false;
  let frame = 0;
  let lastFrame = now();
  let baseline = null;
  let preferred = readPreference(storage);
  let current = { x: 0, y: 0 };
  let destination = { x: 0, y: 0 };
  let state = { supported: false, enabled: false, permission: "idle" };
  const subscribers = new Set();

  const query = (value) => windowTarget?.matchMedia?.(value)?.matches ?? false;
  const reduced = () => query("(prefers-reduced-motion: reduce)");
  const finePointer = () => query("(hover: hover) and (pointer: fine)");
  const coarsePointer = () => query("(hover: none), (pointer: coarse)");
  const orientationConstructor = () => windowTarget?.DeviceOrientationEvent;
  const hasOrientation = () => Boolean(
    orientationConstructor()
      || (windowTarget && "ondeviceorientation" in windowTarget),
  );
  const supported = () => Boolean(windowTarget && coarsePointer() && hasOrientation() && !reduced());

  const notify = () => {
    const snapshot = { ...state };
    subscribers.forEach((subscriber) => subscriber(snapshot));
  };

  const setState = (next) => {
    const merged = { ...state, ...next };
    if (
      merged.supported === state.supported
      && merged.enabled === state.enabled
      && merged.permission === state.permission
    ) return;
    state = merged;
    notify();
  };

  const persist = (enabled) => {
    preferred = enabled;
    try {
      storage?.setItem(MOTION_PREFERENCE_KEY, String(enabled));
    } catch {
      // Motion is a progressive enhancement; blocked storage is harmless.
    }
  };

  const dispatchPose = (detail) => {
    if (!windowTarget?.dispatchEvent) return;
    const EventConstructor = windowTarget.CustomEvent || globalThis.CustomEvent;
    if (!EventConstructor) return;
    windowTarget.dispatchEvent(new EventConstructor(MOTION_POSE_EVENT, { detail }));
  };

  const render = (timestamp) => {
    frame = 0;
    if (!mounted || !ambient) return;
    const delta = Math.min(0.05, Math.max(0.001, (timestamp - lastFrame) / 1000));
    lastFrame = timestamp;
    const blend = 1 - Math.exp(-8 * delta);
    current.x += (destination.x - current.x) * blend;
    current.y += (destination.y - current.y) * blend;
    ambient.style.setProperty("--ambient-parallax-x", `${(-current.x * BACKGROUND_X_PX).toFixed(2)}px`);
    ambient.style.setProperty("--ambient-parallax-y", `${(-current.y * BACKGROUND_Y_PX).toFixed(2)}px`);

    if (Math.abs(destination.x - current.x) + Math.abs(destination.y - current.y) > 0.002) {
      frame = requestFrame(render);
    }
  };

  const schedule = () => {
    if (frame || !mounted || !ambient) return;
    lastFrame = now();
    frame = requestFrame(render);
  };

  const setBackgroundPose = (x, y) => {
    destination = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
    schedule();
  };

  const resetPose = ({ immediate = false } = {}) => {
    destination = { x: 0, y: 0 };
    baseline = null;
    dispatchPose({ active: false, x: 0, y: 0 });
    if (immediate) {
      if (frame) cancelFrame(frame);
      frame = 0;
      current = { x: 0, y: 0 };
      ambient?.style.removeProperty("--ambient-parallax-x");
      ambient?.style.removeProperty("--ambient-parallax-y");
      return;
    }
    schedule();
  };

  const handlePointerMove = (event) => {
    if (!finePointer() || reduced() || !windowTarget.innerWidth || !windowTarget.innerHeight) return;
    setBackgroundPose(
      ((event.clientX / windowTarget.innerWidth) - 0.5) * 2,
      ((event.clientY / windowTarget.innerHeight) - 0.5) * 2,
    );
  };

  const handleOrientation = (event) => {
    if (!state.enabled || documentTarget?.hidden) return;
    if (!Number.isFinite(event.beta) || !Number.isFinite(event.gamma)) return;
    if (!baseline) baseline = { beta: event.beta, gamma: event.gamma };
    const pose = normalizeDeviceOrientation(event, baseline, readScreenAngle(windowTarget));
    if (!pose) return;
    setBackgroundPose(pose.x * 0.82, pose.y * 0.82);
    dispatchPose({ active: true, ...pose });
  };

  const handleVisibility = () => {
    if (documentTarget?.hidden) resetPose();
  };

  const handleOrientationChange = () => {
    baseline = null;
  };

  const startOrientation = () => {
    if (!mounted || orientationListening || !supported()) return false;
    baseline = null;
    windowTarget.addEventListener("deviceorientation", handleOrientation, { passive: true });
    orientationListening = true;
    setState({ supported: true, enabled: true, permission: "granted" });
    persist(true);
    return true;
  };

  const stopOrientation = ({ remember = true } = {}) => {
    if (orientationListening) {
      windowTarget.removeEventListener("deviceorientation", handleOrientation);
      orientationListening = false;
    }
    if (remember) persist(false);
    setState({ enabled: false });
    resetPose();
  };

  return {
    getState() {
      return { ...state };
    },

    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },

    mount(nextRoot) {
      root = nextRoot;
      ambient = root?.querySelector?.(".ambient") || null;
      mounted = Boolean(root && ambient && windowTarget);
      const canUseOrientation = supported();
      const needsPermission = typeof orientationConstructor()?.requestPermission === "function";
      setState({
        supported: canUseOrientation,
        enabled: false,
        permission: canUseOrientation && needsPermission ? "prompt" : "idle",
      });

      if (!mounted) return () => {};
      windowTarget.addEventListener("pointermove", handlePointerMove, { passive: true });
      windowTarget.addEventListener("blur", resetPose);
      documentTarget?.addEventListener("visibilitychange", handleVisibility);
      windowTarget.screen?.orientation?.addEventListener?.("change", handleOrientationChange);
      windowTarget.addEventListener?.("orientationchange", handleOrientationChange);

      if (preferred && canUseOrientation && !needsPermission) startOrientation();

      return () => {
        windowTarget.removeEventListener("pointermove", handlePointerMove);
        windowTarget.removeEventListener("blur", resetPose);
        documentTarget?.removeEventListener("visibilitychange", handleVisibility);
        windowTarget.screen?.orientation?.removeEventListener?.("change", handleOrientationChange);
        windowTarget.removeEventListener?.("orientationchange", handleOrientationChange);
        stopOrientation({ remember: false });
        resetPose({ immediate: true });
        root = null;
        ambient = null;
        mounted = false;
      };
    },

    async enable() {
      const canUseOrientation = supported();
      setState({ supported: canUseOrientation });
      if (!mounted || !canUseOrientation) {
        setState({ enabled: false, permission: "unavailable" });
        return false;
      }

      const requestPermission = orientationConstructor()?.requestPermission;
      if (typeof requestPermission === "function") {
        try {
          const permission = await requestPermission.call(orientationConstructor());
          if (permission !== "granted") {
            persist(false);
            setState({ enabled: false, permission: "denied" });
            return false;
          }
        } catch {
          persist(false);
          setState({ enabled: false, permission: "denied" });
          return false;
        }
      }

      return startOrientation();
    },

    disable() {
      stopOrientation();
    },
  };
}

export const deviceMotion = createDeviceMotionService();
