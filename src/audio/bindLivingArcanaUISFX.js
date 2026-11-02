import { uiSfx } from "./uiSfx.js";

const ACTION_CUES = Object.freeze({
  draw: "start",
  archive: "press",
  consultation: "press",
  today: "press",
  home: "press",
  reopen: "open",
  legal: "open",
  changelog: "open",
  "close-overlay": "close",
  "full-card-close": "collapse",
});

export function resolveAppActionCue(action, { view, fullCardState, focusFlipped } = {}) {
  if (action === "home" && view === "today") return null;
  if (action === "archive" && view === "archive") return null;
  if (action === "consultation" && view === "consultation") return null;
  if (action === "today" && ["today", "reading"].includes(view)) return null;
  if (action === "full-card-open" && ["open", "opening"].includes(fullCardState)) return null;
  if (action === "full-card-close" && ["closed", "closing"].includes(fullCardState)) return null;
  return ACTION_CUES[action] || null;
}

export function bindLivingArcanaUISFX(root, service = uiSfx, {
  documentTarget = globalThis.document,
  Observer = globalThis.MutationObserver,
} = {}) {
  if (!root?.addEventListener) return () => {};
  let previousView = root.dataset.view;
  let previousCardState = root.dataset.cardState;

  const handleClick = (event) => {
    const target = event.target;
    if (!target?.closest) return;
    const control = target.closest("button, [role='button'], .archive-card");
    if (!control || control.disabled || control.closest("[inert]")) return;

    const action = control.dataset.action;
    if (action === "draw" || control.classList.contains("archive-card")) service.prepareCardFlip?.();
    if (action === "flip" || action === "focus-flip") {
      service.activateCardFlip?.();
      return;
    }
    if (action === "full-card-open") {
      if (!["open", "opening"].includes(root.dataset.fullCardState)) service.activateCardFlip?.();
      return;
    }
    let cue = resolveAppActionCue(action, {
      view: root.dataset.view,
      fullCardState: root.dataset.fullCardState,
    });
    if (!cue && control.classList.contains("archive-card")) cue = "open";
    if (cue) service.activate(cue);
  };

  const handleKeyDown = (event) => {
    if (event.key !== "Escape" || event.repeat) return;
    if (root.querySelector?.(".overlay[data-open], [data-full-card-state='open'], [data-full-card-state='opening']")) {
      service.activate("close");
    } else if (["reading", "consultation"].includes(root.dataset.view)) {
      service.activate("back");
    }
  };

  const handleSemanticCue = (event) => {
    if (event.detail?.prepareCardFlip) service.prepareCardFlip?.();
    if (event.detail?.cardFlip) {
      service.activateCardFlip?.();
      return;
    }
    if (typeof event.detail?.cue === "string") service.activate(event.detail.cue);
  };

  const observer = Observer ? new Observer(() => {
    const nextView = root.dataset.view;
    const nextCardState = root.dataset.cardState;
    if (nextView !== previousView) {
      previousView = nextView;
      service.stopAllLoops();
    }
    if (previousCardState === "activating" && nextCardState === "live") service.play("complete");
    previousCardState = nextCardState;
  }) : null;

  root.addEventListener("click", handleClick, true);
  root.addEventListener("living-arcana:sfx", handleSemanticCue);
  documentTarget?.addEventListener("keydown", handleKeyDown, true);
  observer?.observe(root, { attributes: true, attributeFilter: ["data-view", "data-card-state"] });

  return () => {
    root.removeEventListener("click", handleClick, true);
    root.removeEventListener("living-arcana:sfx", handleSemanticCue);
    documentTarget?.removeEventListener("keydown", handleKeyDown, true);
    observer?.disconnect();
    service.stopAllLoops();
  };
}
