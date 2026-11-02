import { createDualFaceCardMaterial } from "../dualFaceCardMaterial.js";

const OPEN_DURATION = 920;
const CLOSE_DURATION = 860;
const HANDOFF_OFFSET = 0.58;
const RELEASE_OFFSET = 0.163;
const EDGE_BACK_OFFSET = 0.603;
const EDGE_FRONT_OFFSET = 0.636;
const APPROACH_OFFSET = 0.91;
const CLOSE_EDGE_FRONT = 0.48;
const CLOSE_EDGE_BACK = 0.482;
const CLOSE_UNDER_SETTLE = 0.72;
const CLOSE_ROTATION_SETTLE = 0.86;
const CLOSE_LAYER_HANDOFF_MS = Math.round(CLOSE_DURATION * CLOSE_EDGE_BACK);
const OPEN_EASING = "cubic-bezier(0.42, 0, 0.58, 1)";
const CLOSE_EASING = "cubic-bezier(0.455, 0.03, 0.515, 0.955)";
const BREATHE_RESET_DURATION = 160;
const BREATHE_RESTART_DELAY = 120;
const BREATHE_NEUTRAL_TRANSFORM = "translate3d(0, 0, 0) rotateZ(0deg)";
const BREATHE_ANIMATION = "source-card-breathe 5200ms cubic-bezier(0.455, 0.03, 0.515, 0.955) infinite";

function targetGeometry(stage) {
  const rect = stage.parentElement.getBoundingClientRect();
  const targetWidth = Math.min(420, window.innerWidth * 0.82, window.innerHeight * 0.82 * 0.625);
  return {
    startX: 24,
    startY: 14,
    startZ: -42,
    targetX: window.innerWidth / 2 - (rect.left + rect.width / 2),
    targetY: window.innerHeight / 2 - (rect.top + rect.height / 2),
    scale: Math.min(1.35, targetWidth / rect.width),
  };
}

function openStageFrames({ startX, startY, startZ, targetX, targetY, scale }) {
  const clearX = startX + Math.min(176, Math.max(132, Math.abs(targetX - startX) * 0.5));
  return [
    { transform: `perspective(1200px) translate3d(${startX}px, ${startY}px, ${startZ}px) scale(1)`, zIndex: 1, offset: 0 },
    { transform: `perspective(1200px) translate3d(${clearX * 0.62}px, ${startY - 4}px, -54px) scale(1)`, zIndex: 1, offset: RELEASE_OFFSET },
    { transform: `perspective(1200px) translate3d(${clearX}px, ${startY - 10}px, -16px) scale(${1 + (scale - 1) * 0.13})`, zIndex: 1, offset: EDGE_BACK_OFFSET },
    { transform: `perspective(1200px) translate3d(${clearX + 2}px, ${startY - 10}px, 8px) scale(${1 + (scale - 1) * 0.15})`, zIndex: 60, offset: EDGE_FRONT_OFFSET },
    { transform: `perspective(1200px) translate3d(${clearX + (targetX - clearX) * 0.52}px, ${startY + (targetY - startY) * 0.58}px, 132px) scale(${1 + (scale - 1) * 0.72})`, zIndex: 60, offset: APPROACH_OFFSET },
    { transform: `perspective(1200px) translate3d(${targetX}px, ${targetY}px, 0) scale(${scale})`, zIndex: 60, offset: 1 },
  ];
}

const OPEN_CARD_FRAMES = [
  { transform: "perspective(1100px) rotateY(-6deg) rotateZ(5deg)", offset: 0 },
  { transform: "perspective(1100px) rotateY(-15deg) rotateZ(5.1deg)", offset: RELEASE_OFFSET },
  { transform: "perspective(1100px) rotateY(-68deg) rotateZ(3.25deg)", offset: EDGE_BACK_OFFSET },
  { transform: "perspective(1100px) rotateY(-66deg) rotateZ(3deg)", offset: EDGE_FRONT_OFFSET },
  { transform: "perspective(1100px) rotateY(-15deg) rotateZ(0.8deg)", offset: APPROACH_OFFSET },
  { transform: "perspective(1100px) rotateY(0deg) rotateZ(0deg)", offset: 1 },
];

function closeStageFrames({ startX, startY, startZ, targetX, targetY, scale }) {
  const clearX = startX + Math.min(176, Math.max(132, Math.abs(targetX - startX) * 0.5));
  const departX = targetX + (clearX - targetX) * 0.38;
  const departY = targetY + (startY - targetY) * 0.28;
  return [
    { transform: `perspective(1200px) translate3d(${targetX}px, ${targetY}px, 0) scale(${scale})`, offset: 0 },
    { transform: `perspective(1200px) translate3d(${departX}px, ${departY}px, -8px) scale(${1 + (scale - 1) * 0.72})`, offset: 0.18 },
    { transform: `perspective(1200px) translate3d(${clearX + 2}px, ${startY - 10}px, 6px) scale(${1 + (scale - 1) * 0.15})`, offset: CLOSE_EDGE_FRONT },
    { transform: `perspective(1200px) translate3d(${clearX}px, ${startY - 10}px, -18px) scale(${1 + (scale - 1) * 0.13})`, offset: CLOSE_EDGE_BACK },
    { transform: `perspective(1200px) translate3d(${clearX * 0.62}px, ${startY - 4}px, -54px) scale(1)`, offset: CLOSE_UNDER_SETTLE },
    { transform: `perspective(1200px) translate3d(${startX}px, ${startY}px, ${startZ}px) scale(1)`, offset: 1 },
  ];
}

const CLOSE_CARD_FRAMES = [
  { transform: "perspective(1100px) rotateY(0deg) rotateZ(0deg)", offset: 0 },
  { transform: "perspective(1100px) rotateY(-12deg) rotateZ(0.8deg)", offset: 0.18 },
  { transform: "perspective(1100px) rotateY(-66deg) rotateZ(3deg)", offset: CLOSE_EDGE_FRONT },
  { transform: "perspective(1100px) rotateY(-68deg) rotateZ(3.25deg)", offset: CLOSE_EDGE_BACK },
  // Restore the face-on width across the whole remaining travel. Jumping
  // straight from -68deg to -15deg made the returning rear card appear to
  // inflate just after it passed behind the avatar card.
  { transform: "perspective(1100px) rotateY(-40deg) rotateZ(4.05deg)", offset: CLOSE_UNDER_SETTLE },
  { transform: "perspective(1100px) rotateY(-23deg) rotateZ(4.55deg)", offset: CLOSE_ROTATION_SETTLE },
  { transform: "perspective(1100px) rotateY(-6deg) rotateZ(5deg)", offset: 1 },
];

export function setupFullCardExpansion(app) {
  const stage = app.querySelector(".source-card-stage");
  const breathe = app.querySelector(".source-card-breathe");
  const card = app.querySelector(".source-card");
  const cardMaterialLayer = card?.querySelector(".source-card-material");
  const cardMaterialCanvas = card?.querySelector(".source-card-diffraction-canvas");
  const scrim = app.querySelector(".plate-scrim");
  const triggers = app.querySelectorAll('[data-action="full-card-open"]');
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let state = "closed";
  let stageAnimation = null;
  let cardAnimation = null;
  let animationMode = null;
  let handoffTimer = null;
  let breatheResetAnimation = null;
  let breatheRestartTimer = null;

  if (!stage || !breathe || !card || !scrim) return () => {};

  const materialStrength = () => {
    const value = Number.parseFloat(getComputedStyle(app).getPropertyValue("--home-holographic-strength"));
    return Number.isFinite(value) ? value : 0.68;
  };
  const expandedCardMaterial = createDualFaceCardMaterial({
    target: card,
    tilt: cardMaterialLayer,
    frontCanvas: cardMaterialCanvas,
    reducedMotion: reduced,
    hoverScale: 1.014,
    maxTilt: 3.25,
    observeFrontResize: false,
    enabled: () => state === "open",
    getFrontArtworkUrl: () => card.querySelector(".static-artwork-image")?.currentSrc || "",
    getStrength: materialStrength,
  });

  const setBackgroundInert = (inert) => {
    app.querySelectorAll(".site-header, .site-footer, .reading-copy, .card-hitbox")
      .forEach((element) => { element.inert = inert; });
  };
  const clearHandoff = () => {
    if (handoffTimer !== null) window.clearTimeout(handoffTimer);
    handoffTimer = null;
  };
  const clearAnimations = () => {
    clearHandoff();
    stageAnimation?.cancel();
    cardAnimation?.cancel();
    stageAnimation = null;
    cardAnimation = null;
    animationMode = null;
  };
  const clearBreatheRestart = () => {
    if (breatheRestartTimer !== null) window.clearTimeout(breatheRestartTimer);
    breatheRestartTimer = null;
  };
  const settleBreatheAtNeutral = () => {
    clearBreatheRestart();
    breatheResetAnimation?.cancel();
    breatheResetAnimation = null;
    breathe.style.animation = "none";
    breathe.style.transform = BREATHE_NEUTRAL_TRANSFORM;
  };
  const suspendBreathe = () => {
    clearBreatheRestart();
    breatheResetAnimation?.cancel();
    const currentTransform = getComputedStyle(breathe).transform;
    breathe.style.animation = "none";
    breathe.style.transform = currentTransform === "none" ? BREATHE_NEUTRAL_TRANSFORM : currentTransform;
    if (reduced || currentTransform === "none") {
      breathe.style.transform = BREATHE_NEUTRAL_TRANSFORM;
      breatheResetAnimation = null;
      return;
    }
    const animation = breathe.animate([
      { transform: currentTransform },
      { transform: BREATHE_NEUTRAL_TRANSFORM },
    ], {
      duration: BREATHE_RESET_DURATION,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
      fill: "both",
    });
    breatheResetAnimation = animation;
    animation.onfinish = () => {
      if (breatheResetAnimation !== animation) return;
      breathe.style.transform = BREATHE_NEUTRAL_TRANSFORM;
      animation.cancel();
      breatheResetAnimation = null;
    };
  };
  const restartBreatheFromNeutral = () => {
    settleBreatheAtNeutral();
    if (reduced) return;
    breatheRestartTimer = window.setTimeout(() => {
      breatheRestartTimer = null;
      if (state !== "closed") return;
      // Removing an inline `animation: none` can resume the stylesheet's old
      // CSS animation timeline. Force a new animation instance so the resting
      // card always restarts from the neutral 0deg/0px keyframe.
      breathe.style.animation = "none";
      breathe.getBoundingClientRect();
      breathe.style.removeProperty("transform");
      breathe.style.animation = BREATHE_ANIMATION;
    }, BREATHE_RESTART_DELAY);
  };
  const finishClosed = ({ restoreFocus = true } = {}) => {
    // The close animation ends on the same transforms as the CSS resting
    // state. Remove the temporary close-start snapshot before cancelling the
    // filled animations so the handoff remains visually continuous.
    stage.style.removeProperty("transform");
    stage.style.removeProperty("z-index");
    card.style.removeProperty("transform");
    clearAnimations();
    state = "closed";
    app.dataset.fullCardState = "closed";
    app.removeAttribute("data-full-card-layer");
    app.removeAttribute("data-full-card-motion");
    app.removeAttribute("data-full-card-appearance");
    expandedCardMaterial.reset({ immediate: true });
    restartBreatheFromNeutral();
    card.setAttribute("aria-expanded", "false");
    setBackgroundInert(false);
    if (restoreFocus && app.dataset.view === "reading") card.focus({ preventScroll: true });
  };
  const finishOpen = () => {
    clearHandoff();
    state = "open";
    app.dataset.fullCardState = "open";
    app.dataset.fullCardLayer = "artwork";
    app.dataset.fullCardAppearance = "expanded";
    card.setAttribute("aria-expanded", "true");
    expandedCardMaterial.sync();
  };
  const bindFinish = (mode) => {
    animationMode = mode;
    const animation = stageAnimation;
    animation.onfinish = () => {
      const reversed = animation.playbackRate < 0;
      const endsClosed = mode === "open" ? reversed : !reversed;
      if (endsClosed) finishClosed();
      else finishOpen();
    };
  };

  const open = (event) => {
    event?.stopPropagation();
    if (card.disabled || ["open", "opening"].includes(state)) return;
    suspendBreathe();

    if (state === "closing" && stageAnimation && cardAnimation) {
      clearHandoff();
      state = "opening";
      app.dataset.fullCardLayer = "artwork";
      card.setAttribute("aria-expanded", "true");
      setBackgroundInert(true);
      if (animationMode === "close") {
        app.dataset.fullCardState = "open";
        stageAnimation.playbackRate = -1;
        cardAnimation.playbackRate = -1;
      } else {
        const handoffTime = OPEN_DURATION * HANDOFF_OFFSET;
        const currentTime = Number(stageAnimation.currentTime) || 0;
        app.dataset.fullCardState = currentTime >= handoffTime ? "open" : "opening";
        if (currentTime < handoffTime) {
          handoffTimer = window.setTimeout(() => {
            if (state === "opening") app.dataset.fullCardState = "open";
            handoffTimer = null;
          }, handoffTime - currentTime);
        }
        stageAnimation.playbackRate = 1;
        cardAnimation.playbackRate = 1;
      }
      stageAnimation.play();
      cardAnimation.play();
      return;
    }

    const geometry = targetGeometry(stage);
    state = "opening";
    app.dataset.fullCardState = "opening";
    app.dataset.fullCardMotion = "active";
    app.removeAttribute("data-full-card-appearance");
    expandedCardMaterial.reset({ immediate: true });
    card.setAttribute("aria-expanded", "true");
    setBackgroundInert(true);
    if (reduced) {
      stage.style.transform = `perspective(1200px) translate3d(${geometry.targetX}px, ${geometry.targetY}px, 0) scale(${geometry.scale})`;
      stage.style.zIndex = "60";
      card.style.transform = "none";
      finishOpen();
      return;
    }
    clearAnimations();
    stageAnimation = stage.animate(openStageFrames(geometry), { duration: OPEN_DURATION, easing: OPEN_EASING, fill: "both" });
    cardAnimation = card.animate(OPEN_CARD_FRAMES, { duration: OPEN_DURATION, easing: OPEN_EASING, fill: "both" });
    handoffTimer = window.setTimeout(() => {
      if (state === "opening") app.dataset.fullCardState = "open";
      handoffTimer = null;
    }, OPEN_DURATION * HANDOFF_OFFSET);
    bindFinish("open");
  };

  const close = (event) => {
    event?.stopPropagation();
    if (["closed", "closing"].includes(state)) return;
    const wasOpen = state === "open";
    clearHandoff();
    state = "closing";
    app.dataset.fullCardState = "closing";
    app.removeAttribute("data-full-card-appearance");
    expandedCardMaterial.reset();
    card.setAttribute("aria-expanded", "false");
    if (reduced) {
      stage.style.removeProperty("transform");
      stage.style.removeProperty("z-index");
      card.style.removeProperty("transform");
      finishClosed();
      return;
    }
    if (!stageAnimation || !cardAnimation) {
      finishClosed();
      return;
    }
    app.dataset.fullCardMotion = "active";
    if (wasOpen) {
      const geometry = targetGeometry(stage);
      // Freeze the expanded transform and keep the artwork in the explicit
      // foreground layer while the completed open animation is replaced.
      // The layer switches discretely later; z-index is never interpolated.
      app.dataset.fullCardLayer = "artwork";
      stage.style.transform = `perspective(1200px) translate3d(${geometry.targetX}px, ${geometry.targetY}px, 0) scale(${geometry.scale})`;
      card.style.transform = "perspective(1100px) rotateY(0deg) rotateZ(0deg)";
      clearAnimations();
      stageAnimation = stage.animate(closeStageFrames(geometry), { duration: CLOSE_DURATION, easing: CLOSE_EASING, fill: "both" });
      cardAnimation = card.animate(CLOSE_CARD_FRAMES, { duration: CLOSE_DURATION, easing: CLOSE_EASING, fill: "both" });
      handoffTimer = window.setTimeout(() => {
        if (state === "closing") app.dataset.fullCardLayer = "avatar";
        handoffTimer = null;
      }, CLOSE_LAYER_HANDOFF_MS);
      bindFinish("close");
      return;
    }
    stageAnimation.playbackRate = -1;
    cardAnimation.playbackRate = -1;
    stageAnimation.play();
    cardAnimation.play();
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape" && state !== "closed") {
      event.preventDefault();
      close();
    }
  };
  const onResize = () => {
    if (state === "closed") return;
    clearAnimations();
    stage.style.removeProperty("transform");
    stage.style.removeProperty("z-index");
    card.style.removeProperty("transform");
    finishClosed({ restoreFocus: false });
  };

  app.dataset.fullCardState = "closed";
  triggers.forEach((trigger) => trigger.addEventListener("click", open));
  scrim.addEventListener("click", close);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResize);

  return () => {
    triggers.forEach((trigger) => trigger.removeEventListener("click", open));
    scrim.removeEventListener("click", close);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", onResize);
    clearAnimations();
    clearBreatheRestart();
    breatheResetAnimation?.cancel();
    breatheResetAnimation = null;
    breathe.style.removeProperty("animation");
    breathe.style.removeProperty("transform");
    expandedCardMaterial.destroy();
    setBackgroundInert(false);
    app.removeAttribute("data-full-card-state");
    app.removeAttribute("data-full-card-motion");
    app.removeAttribute("data-full-card-appearance");
  };
}
