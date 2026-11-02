import { CARD_HOLOGRAPHIC_STRENGTH_EVENT } from "./cardArtworkTuning.js";
import { createCardBackMetalShader } from "./cardBackMetalShader.js";
import { createCardDiffractionShader } from "./cardHoverMaterial.js";
import { MOTION_POSE_EVENT } from "./motion/deviceMotion.js";

const NOOP_CONTROLLER = Object.freeze({
  destroy() {},
  reset() {},
  sync() {},
});

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/**
 * Shared physical-material interaction for every reading surface:
 * portrait side = UV-locked diffraction, reverse side = metallic light sweep.
 */
export function createDualFaceCardMaterial({
  target,
  tilt,
  frontCanvas = null,
  backCanvas = null,
  getSide = () => frontCanvas ? "front" : "back",
  getFrontArtworkUrl = () => "",
  getStrength = () => 0.68,
  observeFrontResize = true,
  enabled = () => true,
  hoverScale = 1.012,
  maxTilt = 3.25,
  reducedMotion = false,
  motionTarget = globalThis.window,
} = {}) {
  if (!target || !tilt || (!frontCanvas && !backCanvas) || reducedMotion) {
    return NOOP_CONTROLLER;
  }

  const frontMaterial = createCardDiffractionShader(frontCanvas, {
    getArtworkUrl: getFrontArtworkUrl,
    getStrength,
    observeResize: observeFrontResize,
    reducedMotion,
  });
  const backMaterial = createCardBackMetalShader(backCanvas, { reducedMotion });

  let destroyed = false;
  let hovering = false;
  let frame = 0;
  let lastFrame = performance.now();
  let current = { x: 0.5, y: 0.5, intensity: 0 };
  let destination = { ...current };
  let motionActive = false;

  const side = () => getSide() === "back" ? "back" : "front";

  const routeMaterials = () => {
    const isEnabled = Boolean(enabled());
    const currentSide = side();
    frontMaterial.setActive(isEnabled && currentSide === "front");
    backMaterial.setActive(isEnabled && currentSide === "back");
    if (!isEnabled || currentSide !== "front") frontMaterial.setIdle();
    if (!isEnabled || currentSide !== "back") backMaterial.setIdle();
  };

  const render = () => {
    const isEnabled = Boolean(enabled());
    const intensity = isEnabled ? clamp01(current.intensity) : 0;
    const rotateX = (0.5 - current.y) * maxTilt * 2 * intensity;
    const rotateY = (current.x - 0.5) * maxTilt * 2 * intensity;
    const scale = 1 + (hoverScale - 1) * intensity;

    // Read the visible face's box before dirtying styles (see measure()).
    (side() === "front" ? frontMaterial : backMaterial).measure();
    tilt.style.setProperty("--card-material-rx", `${rotateX.toFixed(3)}deg`);
    tilt.style.setProperty("--card-material-ry", `${rotateY.toFixed(3)}deg`);
    tilt.style.setProperty("--card-material-scale", scale.toFixed(4));

    if (side() === "front") {
      frontMaterial.setPose(rotateX, rotateY, intensity);
    } else if ((hovering || motionActive) && intensity > 0.001) {
      backMaterial.setPointer(current.x, current.y, 0.12 + intensity * 0.64);
    } else {
      backMaterial.setIdle();
    }
  };

  const animate = (now) => {
    frame = 0;
    if (destroyed) return;
    const delta = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
    lastFrame = now;
    const pointerBlend = 1 - Math.exp(-18 * delta);
    const intensityBlend = 1 - Math.exp(-(destination.intensity > current.intensity ? 15 : 12) * delta);
    current.x += (destination.x - current.x) * pointerBlend;
    current.y += (destination.y - current.y) * pointerBlend;
    current.intensity += (destination.intensity - current.intensity) * intensityBlend;
    render();

    const unsettled = Math.abs(destination.x - current.x)
      + Math.abs(destination.y - current.y)
      + Math.abs(destination.intensity - current.intensity) > 0.0015;
    if (unsettled) frame = requestAnimationFrame(animate);
  };

  const schedule = () => {
    if (frame || destroyed) return;
    lastFrame = performance.now();
    frame = requestAnimationFrame(animate);
  };

  const pointerPosition = (event) => {
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  const onPointerEnter = (event) => {
    if (event.pointerType === "touch" || !enabled()) return;
    const pointer = pointerPosition(event);
    if (!pointer) return;
    hovering = true;
    destination = { ...pointer, intensity: 1 };
    routeMaterials();
    frontMaterial.refresh();
    schedule();
  };

  const onPointerMove = (event) => {
    if (event.pointerType === "touch" || !hovering || !enabled()) return;
    const pointer = pointerPosition(event);
    if (!pointer) return;
    destination = { ...pointer, intensity: 1 };
    schedule();
  };

  const reset = ({ immediate = false } = {}) => {
    hovering = false;
    motionActive = false;
    destination = { x: 0.5, y: 0.5, intensity: 0 };
    if (immediate) {
      cancelAnimationFrame(frame);
      frame = 0;
      current = { ...destination };
      render();
    } else {
      schedule();
    }
  };

  const onMotionPose = (event) => {
    const pose = event.detail;
    if (!pose?.active || !enabled()) {
      if (motionActive) {
        reset();
        routeMaterials();
      }
      return;
    }
    const wasActive = motionActive;
    motionActive = true;
    hovering = true;
    destination = {
      x: clamp01(0.5 + clamp01((pose.x + 1) / 2) * 0.72 - 0.36),
      y: clamp01(0.5 + clamp01((pose.y + 1) / 2) * 0.72 - 0.36),
      intensity: 0.78,
    };
    routeMaterials();
    if (!wasActive) frontMaterial.refresh();
    schedule();
  };

  const sync = () => {
    routeMaterials();
    frontMaterial.refresh();
    render();
  };

  const onPointerLeave = () => reset();
  const onFocus = () => {
    if (!enabled()) return;
    hovering = true;
    destination = { x: 0.62, y: 0.38, intensity: 0.72 };
    routeMaterials();
    schedule();
  };
  const onBlur = () => reset();
  const onVisibilityChange = () => {
    if (document.hidden) reset({ immediate: true });
  };
  const onStrengthChange = () => render();

  target.addEventListener("pointerenter", onPointerEnter, { passive: true });
  target.addEventListener("pointermove", onPointerMove, { passive: true });
  target.addEventListener("pointerleave", onPointerLeave, { passive: true });
  target.addEventListener("focus", onFocus, { passive: true });
  target.addEventListener("blur", onBlur, { passive: true });
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener(CARD_HOLOGRAPHIC_STRENGTH_EVENT, onStrengthChange);
  motionTarget?.addEventListener?.(MOTION_POSE_EVENT, onMotionPose);
  sync();

  return {
    reset,
    sync,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      target.removeEventListener("pointerenter", onPointerEnter);
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerleave", onPointerLeave);
      target.removeEventListener("focus", onFocus);
      target.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener(CARD_HOLOGRAPHIC_STRENGTH_EVENT, onStrengthChange);
      motionTarget?.removeEventListener?.(MOTION_POSE_EVENT, onMotionPose);
      frontMaterial.destroy();
      backMaterial.destroy();
      tilt.style.removeProperty("--card-material-rx");
      tilt.style.removeProperty("--card-material-ry");
      tilt.style.removeProperty("--card-material-scale");
    },
  };
}
