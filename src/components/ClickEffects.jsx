import { useEffect, useRef } from "react";
import "./ClickEffects.css";

const EFFECT_LIFETIME_MS = 700;
const MAX_ACTIVE_EFFECTS = 8;
const PARTICLE_COUNT = 8;

export function pickClickEffect(random = Math.random) {
  return random() < 0.5 ? "crosshair" : "particles";
}

function createCrosshair() {
  const effect = document.createElement("span");
  effect.className = "click-effect click-effect--crosshair";

  for (const direction of ["north", "east", "south", "west"]) {
    const line = document.createElement("i");
    line.className = `click-effect-crosshair__line click-effect-crosshair__line--${direction}`;
    effect.append(line);
  }

  return effect;
}

function createParticles() {
  const effect = document.createElement("span");
  effect.className = "click-effect click-effect--particles";
  const rotation = Math.random() * (Math.PI / 4);

  for (let index = 0; index < PARTICLE_COUNT; index += 1) {
    const angle = rotation + (index / PARTICLE_COUNT) * Math.PI * 2;
    const radius = 34 + Math.random() * 12;
    const particle = document.createElement("i");
    particle.className = "click-effect-particle";
    particle.style.setProperty("--particle-x", `${Math.cos(angle) * radius}px`);
    particle.style.setProperty("--particle-y", `${Math.sin(angle) * radius}px`);
    particle.style.setProperty("--particle-delay", `${Math.random() * 36}ms`);
    particle.style.setProperty("--particle-size", `${index % 3 === 0 ? 3 : 2}px`);
    particle.style.setProperty(
      "--particle-color",
      index % 2 === 0 ? "rgba(245, 239, 220, 0.96)" : "rgba(205, 181, 128, 0.94)",
    );
    effect.append(particle);
  }

  return effect;
}

/**
 * A lightweight, one-shot interpretation of OriginKit's Click Effects.
 * Direct DOM nodes keep a burst from scheduling a React render per click.
 */
export default function ClickEffects() {
  const layerRef = useRef(null);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return undefined;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const cleanupTimers = new Set();

    const handleClick = (event) => {
      if (event.button !== 0 || event.detail === 0 || reducedMotion.matches || !finePointer.matches) return;

      const effect = pickClickEffect() === "crosshair" ? createCrosshair() : createParticles();
      effect.style.setProperty("--click-x", `${event.clientX}px`);
      effect.style.setProperty("--click-y", `${event.clientY}px`);
      layer.append(effect);

      while (layer.childElementCount > MAX_ACTIVE_EFFECTS) layer.firstElementChild?.remove();

      const timer = window.setTimeout(() => {
        effect.remove();
        cleanupTimers.delete(timer);
      }, EFFECT_LIFETIME_MS);
      cleanupTimers.add(timer);
    };

    window.addEventListener("click", handleClick, { passive: true });

    return () => {
      window.removeEventListener("click", handleClick);
      cleanupTimers.forEach((timer) => window.clearTimeout(timer));
      layer.replaceChildren();
    };
  }, []);

  return <div ref={layerRef} className="click-effects-layer" aria-hidden="true" />;
}
