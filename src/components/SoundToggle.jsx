import { useEffect, useState } from "react";
import IconMusic from "@tabler/icons-react/dist/esm/icons/IconMusic.mjs";
import IconMusicOff from "@tabler/icons-react/dist/esm/icons/IconMusicOff.mjs";
import IconVolume2 from "@tabler/icons-react/dist/esm/icons/IconVolume2.mjs";
import IconVolumeOff from "@tabler/icons-react/dist/esm/icons/IconVolumeOff.mjs";
import { backgroundMusic } from "../audio/backgroundMusic.js";
import { uiSfx } from "../audio/uiSfx.js";
import "./SoundToggle.css";

const ICON_PROPS = {
  "aria-hidden": true,
  className: "audio-control-icon",
  focusable: "false",
  size: 18,
  stroke: 1.5,
};

function SoundIcon({ enabled }) {
  const Icon = enabled ? IconVolume2 : IconVolumeOff;
  return <Icon {...ICON_PROPS} />;
}

function MusicIcon({ enabled }) {
  const Icon = enabled ? IconMusic : IconMusicOff;
  return <Icon {...ICON_PROPS} />;
}

export default function SoundToggle() {
  const [sfxPreferences, setSfxPreferences] = useState(uiSfx.getPreferences);
  const [musicPreferences, setMusicPreferences] = useState(backgroundMusic.getPreferences);

  useEffect(() => uiSfx.subscribe(setSfxPreferences), []);
  useEffect(() => backgroundMusic.subscribe(setMusicPreferences), []);

  const toggleSfx = () => {
    const next = !sfxPreferences.enabled;
    uiSfx.setEnabled(next);
    if (next) uiSfx.activate("toggle-on");
  };

  const toggleMusic = () => {
    const next = !musicPreferences.enabled;
    uiSfx.activate(next ? "toggle-on" : "toggle-off");
    backgroundMusic.setEnabled(next);
  };

  return (
    <div className="audio-controls" role="group" aria-label="Audio controls">
      <button
        className="audio-control"
        type="button"
        aria-label={musicPreferences.enabled ? "Pause background music" : "Play background music"}
        aria-pressed={musicPreferences.enabled}
        title={musicPreferences.enabled ? "Pause background music" : "Play background music"}
        data-label={musicPreferences.enabled ? "Music on" : "Music off"}
        onClick={toggleMusic}
      >
        <MusicIcon enabled={musicPreferences.enabled} />
      </button>
      <button
        className="audio-control"
        type="button"
        aria-label={sfxPreferences.enabled ? "Mute interface sounds" : "Enable interface sounds"}
        aria-pressed={sfxPreferences.enabled}
        title={sfxPreferences.enabled ? "Mute interface sounds" : "Enable interface sounds"}
        data-label={sfxPreferences.enabled ? "Effects on" : "Effects off"}
        onClick={toggleSfx}
      >
        <SoundIcon enabled={sfxPreferences.enabled} />
      </button>
    </div>
  );
}
