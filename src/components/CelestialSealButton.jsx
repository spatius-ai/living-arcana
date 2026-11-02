import { useRef } from "react";
import RefractionRippleCanvas from "./RefractionRippleCanvas.jsx";
import "./CelestialSealButton.css";

export default function CelestialSealButton({
  className = "",
  children = "Reveal today's card",
  sourceVideoRef,
  sourceVideoRefs,
  saturation,
  contrast,
  brightness,
  blurRadius,
  ...buttonProps
}) {
  const buttonRef = useRef(null);

  return (
    <button
      {...buttonProps}
      ref={buttonRef}
      className={`celestial-seal-cta ${className}`.trim()}
    >
      <RefractionRippleCanvas
        sourceVideoRef={sourceVideoRef}
        sourceVideoRefs={sourceVideoRefs}
        triggerRef={buttonRef}
        saturation={saturation}
        contrast={contrast}
        brightness={brightness}
        blurRadius={blurRadius}
      />
      <span className="seal-emblem" aria-hidden="true">
        <i className="seal-prismatic-flare" />
        <i className="seal-diffraction-ring" />
        <i className="seal-orbit-ring" />
        <i className="seal-orbit-track"><span className="seal-orbit-glint" /></i>
        <i className="seal-star">✦</i>
      </span>
      <span className="seal-copy">
        <span className="seal-label">{children}</span>
      </span>
      <span className="seal-arrow" aria-hidden="true">↗</span>
    </button>
  );
}
