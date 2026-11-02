import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Ambient, ArchiveView, Footer, Header, Overlays, ReadingView, TodayView } from "./components/Experience.jsx";
import CosmicOrb from "./components/CosmicOrb.jsx";
import { ORB_PALETTE } from "./components/CosmicMicOrb.jsx";
import ThreeCardReading from "./components/ThreeCardReading.jsx";
import ClickEffects from "./components/ClickEffects.jsx";
import ErrorBoundary from "./components/ErrorBoundary.jsx";
import { getCardById, getCardByReference, getDailyCard, getLocalDateKey, hasCompletedDailyDraw, SELECTED_DIRECTION } from "./data/tarot.js";
import { createSpatiusBridge } from "./spatius/createSpatiusBridge.js";
import { createSpatiusDirectAdapter } from "./spatius/createSpatiusDirectAdapter.js";
import { setupFullCardExpansion } from "./motion/setupFullCardExpansion.js";
import { deviceMotion } from "./motion/deviceMotion.js";
import { bindBackgroundMusicDucking } from "./audio/backgroundMusic.js";
import { bindLivingArcanaUISFX } from "./audio/bindLivingArcanaUISFX.js";
import { hasRestorableThreeCardSession, readLastView } from "./reading/threeCardSession.js";

const DAILY_CARD_KEY = "living-arcana.daily-card.v1";

function resolveInitialView() {
  return readLastView() === "consultation" && hasRestorableThreeCardSession()
    ? "consultation"
    : "today";
}

function resolveInitialCard() {
  const requested = getCardByReference(new URLSearchParams(window.location.search).get("card"));
  if (requested) return requested;

  const dateKey = getLocalDateKey();
  try {
    const stored = JSON.parse(window.localStorage.getItem(DAILY_CARD_KEY));
    const storedCard = getCardById(stored?.cardId);
    if (stored?.dateKey === dateKey && storedCard) return storedCard;

    const migratingSingleCardPrototype = !stored && window.localStorage.getItem("living-arcana.spatius-tuning.v1");
    const card = migratingSingleCardPrototype ? getCardById("major-01-magician") : getDailyCard();
    window.localStorage.setItem(DAILY_CARD_KEY, JSON.stringify({ dateKey, cardId: card.id }));
    return card;
  } catch {
    return getDailyCard();
  }
}

function readAvatarMap(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    console.warn("[Living Arcana] VITE_SPATIUS_AVATAR_MAP is not valid JSON.");
    return {};
  }
}

export default function App() {
  const experienceRef = useRef(null);
  const activeCardRef = useRef(null);
  const backgroundVideoRefs = useRef([]);
  const ambientVariant = useMemo(() => Math.floor(Math.random() * 3), []);
  const defaultAvatarId = import.meta.env.VITE_SPATIUS_AVATAR_ID;
  const avatarMap = useMemo(() => readAvatarMap(import.meta.env.VITE_SPATIUS_AVATAR_MAP), []);
  const [activeCard] = useState(resolveInitialCard);
  const [initialView] = useState(resolveInitialView);
  activeCardRef.current = activeCard;
  // When today's draw already completed (and no ?card= debug override is
  // active), the FIRST React paint must already show the drawn resting
  // state — flipping it later in an effect flashes the landing page and the
  // unprepared avatar for a frame. The engine's initApp restore block syncs
  // its internal state to these same values. Computed once at mount so a
  // mid-session recompute can never force data-drawn back to "false".
  const [restoredDraw] = useState(
    () => !new URLSearchParams(window.location.search).has("card") && hasCompletedDailyDraw(activeCard.id),
  );
  const spatiusAdapter = useMemo(() => createSpatiusDirectAdapter({
    appId: import.meta.env.VITE_SPATIUS_APP_ID,
    avatarId: defaultAvatarId,
    region: import.meta.env.VITE_SPATIUS_REGION || "ap-northeast",
  }), []);
  const spatius = useMemo(() => createSpatiusBridge(() => spatiusAdapter), [spatiusAdapter]);
  const getCardAvatarId = useCallback(
    (card) => avatarMap[card.id] || card.avatarId || defaultAvatarId,
    [avatarMap, defaultAvatarId],
  );
  // The boot veil (static markup in index.html, painted before any JS) holds
  // until the background video has presented a frame, fonts have settled and
  // today's digital human is preloaded, then lifts — and only then do the landing text/button animations arm, so
  // they play in view instead of finishing beneath the veil. While it holds,
  // the cosmic orb (same one as the mic) is portaled into its slot.
  const [entered, setEntered] = useState(false);
  const [veilOrbSlot, setVeilOrbSlot] = useState(null);
  const reducedMotion = useMemo(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  useEffect(() => {
    let cancelled = false;
    const MAX_WAIT_MS = 10000;
    // A cold AvatarSDK.initialize pulls ~30 MB (SDK, WASM, shared body model),
    // so the digital human gets its own, longer cap: the veil waits for it on
    // ordinary connections but an unreachable CDN cannot hold it forever.
    const MAX_AVATAR_WAIT_MS = 45000;
    const MIN_VEIL_MS = 600;
    // Lets the percent counter visibly land on 100 before the fade starts.
    const READY_SETTLE_MS = 400;

    setVeilOrbSlot(document.querySelector("#boot-veil .boot-veil-orb-slot"));

    // ?veil-hold keeps the veil up forever — debug affordance for tuning the
    // loader without throttling the network.
    if (new URLSearchParams(window.location.search).has("veil-hold")) return undefined;

    const videoReady = window.__ARCANA_BACKGROUND_READY
      ? Promise.resolve()
      : new Promise((resolve) => window.addEventListener("arcana:background-ready", resolve, { once: true }));
    const fontsReady = document.fonts?.ready ?? Promise.resolve();
    // Today's digital human loads under the veil — AvatarSDK.initialize, then
    // its assets through AvatarManager.load — so the draw can awaken it from
    // cache. A failed preload must not hold the veil: the draw retries
    // the same load on demand.
    const avatarReady = Promise.resolve(spatius.preload({
      avatarIds: [getCardAvatarId(activeCardRef.current)],
      onProgress: (fraction) => window.dispatchEvent(new CustomEvent("arcana:avatar-progress", { detail: fraction })),
    }))
      .catch(() => {})
      .then(() => window.dispatchEvent(new Event("arcana:avatar-ready")));
    const cap = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const minHold = cap(Math.max(0, MIN_VEIL_MS - performance.now()));

    Promise.all([
      Promise.race([Promise.all([videoReady, fontsReady]), cap(MAX_WAIT_MS)]),
      Promise.race([avatarReady, cap(MAX_AVATAR_WAIT_MS)]),
      minHold,
    ])
      .then(() => {
        // Releases the percent counter to 100 — also when the wait cap, not
        // the assets, ended the hold.
        window.dispatchEvent(new Event("arcana:boot-ready"));
        return new Promise((resolve) => window.setTimeout(resolve, READY_SETTLE_MS));
      })
      .then(() => {
        if (cancelled) return;
        setEntered(true);
        const veil = document.getElementById("boot-veil");
        if (!veil) return;
        veil.setAttribute("data-leaving", "");
        const remove = () => {
          setVeilOrbSlot(null);
          veil.remove();
        };
        veil.addEventListener("transitionend", remove, { once: true });
        // Reduced motion disables the fade transition, so transitionend never
        // fires there — the timer removes the node either way.
        window.setTimeout(remove, 900);
      });

    return () => {
      cancelled = true;
    };
  }, [getCardAvatarId, spatius]);

  useEffect(() => {
    const experience = experienceRef.current;
    const engine = window.LIVING_ARCANA_ENGINE;
    if (!experience || !engine) return undefined;

    spatius.mount({
      cardId: activeCardRef.current.id,
      root: experience,
      homeTarget: experience.querySelector('[data-spatius-host="home"]'),
      readingTarget: experience.querySelector('[data-spatius-host="reading"]'),
    }).catch(() => {});

    const cleanup = engine.initApp(experience, SELECTED_DIRECTION, {
      spatiusAdapter: spatius,
      getActiveCard: () => activeCardRef.current,
      getCardAvatarId,
      defaultAvatarId,
    });
    const cleanupFullCardExpansion = setupFullCardExpansion(experience);
    const cleanupDeviceMotion = deviceMotion.mount(experience);
    const cleanupUISFX = bindLivingArcanaUISFX(experience);
    const cleanupBackgroundMusicDucking = bindBackgroundMusicDucking(experience);
    const handleResize = () => engine.layoutArchive(experience);
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      cleanupFullCardExpansion();
      cleanupDeviceMotion();
      cleanupUISFX();
      cleanupBackgroundMusicDucking();
      cleanup?.();
      spatius.dispose();
    };
  }, [defaultAvatarId, getCardAvatarId, spatius]);

  return (
    <div
      ref={experienceRef}
      className="variant-app"
      data-variant={SELECTED_DIRECTION.id}
      data-card-id={activeCard.id}
      data-view={initialView}
      data-entered={entered ? "true" : "false"}
      data-drawn={restoredDraw ? "true" : "false"}
      data-card-state={restoredDraw ? "live" : "idle"}
      data-under-card={restoredDraw ? "visible" : "concealed"}
      data-under-card-rendered={restoredDraw ? "true" : "false"}
      data-home-media={restoredDraw ? "video" : "live"}
      data-reading-media="live"
      data-speaking="false"
      data-qa={restoredDraw ? "ready" : "waiting"}
      style={{ "--active-card-motion-poster": `url("${activeCard.composition.staticArtworkUrl}")` }}
    >
      {veilOrbSlot
        ? createPortal(
            <CosmicOrb
              className="boot-veil-orb"
              size={120}
              background="#090b0b"
              palette={ORB_PALETTE}
              speed={reducedMotion ? 0 : 50}
              spin={reducedMotion ? 0 : 50}
              lens
              lensAmount={45}
              style={{ width: 120, height: 120 }}
            />,
            veilOrbSlot,
          )
        : null}
      <Ambient variant={ambientVariant} backgroundVideoRefs={backgroundVideoRefs} />
      <Header />
      <main>
        <TodayView backgroundVideoRefs={backgroundVideoRefs} card={activeCard} entered={entered} />
        <ReadingView variantId={SELECTED_DIRECTION.id} spatius={spatius} card={activeCard} />
        {/* A crash inside the consultation must not take Today and the archive down with it. */}
        <ErrorBoundary label="Three Cards">
          <ThreeCardReading
            spatius={spatius}
            getCardAvatarId={getCardAvatarId}
            todayCard={activeCard}
          />
        </ErrorBoundary>
        <ArchiveView />
      </main>
      <Footer />
      <Overlays variantId={SELECTED_DIRECTION.id} />
      <ClickEffects />
    </div>
  );
}
