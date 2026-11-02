import { useEffect, useState } from "react";
import { uiSfx } from "../audio/uiSfx.js";
import { deviceMotion } from "../motion/deviceMotion.js";

export default function MotionToggle() {
  const [motion, setMotion] = useState(deviceMotion.getState);

  useEffect(() => {
    setMotion(deviceMotion.getState());
    return deviceMotion.subscribe(setMotion);
  }, []);

  if (!motion.supported) return null;

  const toggle = async () => {
    if (motion.enabled) {
      uiSfx.activate("toggle-off", { volume: 0.12 });
      deviceMotion.disable();
      return;
    }

    uiSfx.activate("toggle-on", { volume: 0.12 });
    const enabled = await deviceMotion.enable();
    if (!enabled) uiSfx.play("blocked", { volume: 0.1 });
  };

  const unavailable = ["denied", "unavailable"].includes(motion.permission);
  const label = motion.enabled ? "Motion on" : unavailable ? "Motion unavailable" : "Enable motion";

  return (
    <button
      className="footer-link motion-toggle"
      type="button"
      aria-label={motion.enabled ? "Disable motion effects" : "Enable motion effects"}
      aria-pressed={motion.enabled}
      disabled={unavailable}
      onClick={toggle}
    >
      {label}
    </button>
  );
}
