import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { installBackgroundMusicLifecycle } from "./audio/backgroundMusic.js";
import { installUISFXLifecycle } from "./audio/uiSfx.js";

const rootElement = document.getElementById("stage");

if (!rootElement) throw new Error("Living Arcana root element was not found.");

installUISFXLifecycle();
installBackgroundMusicLifecycle();
// Last resort for a crash outside the per-view boundaries: lift the boot veil
// (it would otherwise spin forever) and offer a reload instead of a blank page.
const crashFallback = (
  <div role="alert" style={{ position: "fixed", inset: 0, display: "grid", placeContent: "center", gap: 16, padding: 24, textAlign: "center" }}>
    <p style={{ margin: 0 }}>Something went wrong while opening Living Arcana.</p>
    <button type="button" onClick={() => window.location.reload()} style={{ justifySelf: "center", padding: "10px 20px", borderRadius: 999, border: "1px solid currentColor", background: "transparent", cursor: "pointer" }}>
      Reload
    </button>
  </div>
);

createRoot(rootElement).render(
  <ErrorBoundary label="App" fallback={crashFallback} onError={() => document.getElementById("boot-veil")?.remove()}>
    <App />
  </ErrorBoundary>,
);
