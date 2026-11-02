import CosmicOrb from "./CosmicOrb.jsx";

export const ORB_PALETTE = {
  anchor: "#6A3CFF",
  colorA: "#3CE0FF",
  colorB: "#A24BFF",
  colorC: "#FF5EA8",
};

export default function CosmicMicOrb({ reducedMotion = false }) {
  return (
    <span className="cosmic-mic-orb-visual">
      <i className="cosmic-mic-aura" aria-hidden="true" />
      <CosmicOrb
        className="cosmic-mic-orb"
        size={50}
        background="#000000"
        palette={ORB_PALETTE}
        speed={reducedMotion ? 0 : 50}
        spin={reducedMotion ? 0 : 50}
        lens
        lensAmount={45}
        style={{ width: 50, height: 50 }}
      />
    </span>
  );
}
