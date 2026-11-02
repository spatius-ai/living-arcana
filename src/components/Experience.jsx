import { useEffect, useRef, useState } from "react";
import { COLLECTION_CHANGE_EVENT, getCollectedIndexSet, TAROT_CARDS } from "../data/tarot.js";
import BlurReveal from "./BlurReveal.jsx";
import CelestialSealButton from "./CelestialSealButton.jsx";
import DuplexComposer from "./DuplexComposer.jsx";
import MotionToggle from "./MotionToggle.jsx";
import SoundToggle from "./SoundToggle.jsx";
import { APP_VERSION, CHANGELOG } from "../version.js";

const REVEAL_PROMPT = "Click the card to reveal";
const LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

function getLocalDatePresentation(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return {
    dateTime: `${year}-${month}-${day}`,
    label: LOCAL_DATE_FORMATTER.format(date),
  };
}

function RevealButton({ backgroundVideoRefs }) {
  return (
    <CelestialSealButton
      sourceVideoRefs={backgroundVideoRefs}
      saturation={0.9}
      contrast={1.03}
      brightness={0.78}
      data-action="draw"
    />
  );
}

function TodayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="6" y="4" width="12" height="16" rx="2" />
      <path d="M9 8h6M9 16h6M12 10v4" />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="11" height="15" rx="2" />
      <path d="m9 5 .4-1.1A2 2 0 0 1 11.3 2.6h5.4a2 2 0 0 1 2 2V16a2 2 0 0 1-2 2H16" />
    </svg>
  );
}

function ThreeCardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="8" y="4" width="8" height="16" rx="1.8" />
      <path d="M8.5 6.5 5.8 7.7a1.8 1.8 0 0 0-1 2.3l3.2 8M15.5 6.5l2.7 1.2a1.8 1.8 0 0 1 1 2.3L16 18" />
    </svg>
  );
}

function StaticArt({ card }) {
  return (
    <div className="static-art">
      <img
        className="static-artwork-image"
        src={card.composition.staticArtworkUrl}
        alt=""
        width="1000"
        height="1600"
        draggable="false"
        decoding="async"
      />
      <span className="card-index">{card.roman} · Major Arcana</span>
      <span className="card-name">{card.name}</span>
    </div>
  );
}

function AvatarArt({ card, home = false }) {
  const { backgroundTransform, frame, overlayTransform } = card.composition;
  const compositionStyle = {
    "--spatius-frame-x": frame.x,
    "--spatius-frame-y": frame.y,
    "--spatius-frame-width": frame.width,
    "--spatius-frame-height": frame.height,
    "--spatius-background-opacity": card.composition.backgroundOpacity,
    "--spatius-background-x": `${backgroundTransform.x}%`,
    "--spatius-background-y": `${backgroundTransform.y}%`,
    "--spatius-background-scale": backgroundTransform.scale,
    "--spatius-overlay-opacity": card.composition.overlayOpacity,
    "--spatius-overlay-x": `${overlayTransform.x}%`,
    "--spatius-overlay-y": `${overlayTransform.y}%`,
    "--spatius-overlay-scale": overlayTransform.scale,
  };

  return (
    <span className={`avatar-art${home ? " today-live-art" : ""}`} data-card-id={card.id} style={compositionStyle}>
      <span
        className="spatius-card-background"
        data-spatius-background=""
        style={{ backgroundImage: card.composition.backgroundUrl ? `url(${JSON.stringify(card.composition.backgroundUrl)})` : undefined }}
        aria-hidden="true"
      />
      <span className="card-index">{card.roman} · Spatius awakened</span>
      <span
        className="avatar-bust"
        data-spatius-host={home ? "home" : "reading"}
        role={home ? undefined : "img"}
        aria-label={home ? undefined : `Digital human for ${card.name}`}
      />
      <span className="card-name">{card.name}</span>
      <span
        className="spatius-card-overlay"
        data-spatius-overlay=""
        style={{ backgroundImage: card.composition.overlayUrl ? `url(${JSON.stringify(card.composition.overlayUrl)})` : undefined }}
        aria-hidden="true"
      />
      {home ? null : <span className="live-status" data-spatius-label="">Preview</span>}
    </span>
  );
}

export function Ambient({ variant, backgroundVideoRefs }) {
  const assignVideoRef = (index) => (node) => {
    if (backgroundVideoRefs?.current) backgroundVideoRefs.current[index] = node;
  };

  return (
    <div className="ambient" data-ambient={variant}>
      <video
        ref={assignVideoRef(0)}
        className="background-video"
        autoPlay
        muted
        playsInline
        preload="auto"
        poster="/assets/videos/meadow-halo-poster.jpg"
        disablePictureInPicture
        aria-hidden="true"
      />
      <video
        ref={assignVideoRef(1)}
        className="background-video"
        muted
        playsInline
        preload="auto"
        poster="/assets/videos/meadow-halo-poster.jpg"
        disablePictureInPicture
        aria-hidden="true"
      />
      <div className="video-scrim" />
    </div>
  );
}

export function Header() {
  return (
    <header className="site-header">
      <button className="wordmark" data-action="home" aria-label="Go to today">
        <span className="wordmark-logo-viewport" aria-hidden="true">
          <img
            className="wordmark-logo"
            src="/assets/brand/arcana-logo.svg"
            alt=""
            width="1901"
            height="497"
            draggable="false"
          />
        </span>
      </button>
      <nav className="icon-nav" aria-label="Main navigation">
        <span className="nav-selection" aria-hidden="true" />
        <button className="icon-button" data-action="today" data-label="Today" data-current="" aria-label="Today" aria-current="page">
          <TodayIcon />
        </button>
        <button className="icon-button" data-action="consultation" data-label="Three cards" aria-label="Three-card reading">
          <ThreeCardIcon />
        </button>
        <button className="icon-button" data-action="archive" data-label="Archive" aria-label="Card library">
          <ArchiveIcon />
        </button>
      </nav>
      <SoundToggle />
    </header>
  );
}

export function TodayView({ backgroundVideoRefs, card, entered = false }) {
  const localDate = getLocalDatePresentation();

  return (
    <section className="scene today-view landing-view" aria-label="Today's card">
      <div className="today-fresh">
        <div className="landing-content">
          <BlurReveal
            as="p"
            className="hero-kicker"
            trigger={entered}
            delay={0.04}
            speedReveal={2}
            speedSegment={0.9}
          >
            One card · once a day
          </BlurReveal>
          <BlurReveal
            as="h1"
            className="landing-cta"
            trigger={entered}
            delay={0.18}
            blur={12}
            yOffset={10}
            stagger={0.027}
            duration={0.68}
          >
            A card for the day ahead.
          </BlurReveal>
          <div className="landing-reveal-button">
            <RevealButton backgroundVideoRefs={backgroundVideoRefs} />
          </div>
        </div>
      </div>
      <div className="today-drawn">
        <div className="today-drawn-content">
          <header className="today-drawn-heading">
            <p className="today-drawn-kicker">Today's Arcana · {card.roman}</p>
            <h1 className="today-drawn-title">Today has spoken.</h1>
          </header>
          <div className="today-card-stack">
            <time className="today-date" dateTime={localDate.dateTime}>{localDate.label}</time>
            <button className="today-card-button" data-action="reopen" aria-label={`Open today's reading for ${card.name}`}>
              <span className="today-card-tilt">
                <span className="today-card-shell">
                  <span className="today-live-source" aria-hidden="true"><AvatarArt card={card} home /></span>
                  <span className="today-video-art">
                    <video
                      className="today-card-video"
                      muted
                      loop
                      playsInline
                      preload="metadata"
                      poster={card.composition.staticArtworkUrl}
                      aria-hidden="true"
                    />
                    <span className="today-video-veil" aria-hidden="true" />
                    <span className="card-index">{card.roman} · {card.name}</span>
                    <span className="card-name">{card.name}</span>
                  </span>
                  <canvas className="today-hover-material" aria-hidden="true" />
                  <canvas className="today-transition-canvas" aria-hidden="true" />
                </span>
              </span>
            </button>
            <p className="today-note">Tomorrow has a card of its own. Come back then.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ReadingView({ variantId, spatius, card }) {
  return (
    <section className="scene reading-view" aria-label="Today's reading">
      <button
        className="plate-scrim"
        type="button"
        data-action="full-card-close"
        aria-label="Close full card artwork"
        tabIndex={-1}
      />
      <div className="reading-layout">
        <div className="card-zone">
          <div className="card-cluster">
            <div className="source-card-stage">
              <div className="source-card-breathe">
                <button
                  className="source-card"
                  type="button"
                  data-action="full-card-open"
                  aria-label="View full card artwork"
                  aria-expanded="false"
                  aria-describedby="full-card-instructions"
                >
                  <span className="source-card-material">
                    <StaticArt card={card} />
                    <canvas className="source-card-diffraction-canvas" aria-hidden="true" />
                  </span>
                </button>
              </div>
            </div>
            <button
              className="source-card-edge-trigger"
              type="button"
              data-action="full-card-open"
              aria-hidden="true"
              tabIndex={-1}
            />
            <button className="card-hitbox" data-action="flip" aria-label="Reveal today's card">
              <span className="card-object">
                <span className="card-flipper">
                  <span className="card-face card-back">
                    <canvas className="card-back-metal-canvas" aria-hidden="true" />
                    <span className="back-mark">A</span>
                  </span>
                  <span className="card-face card-front">
                    <StaticArt card={card} />
                    <AvatarArt card={card} />
                    <span className="return-video-art">
                      <video
                        className="return-card-video"
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        poster={card.composition.staticArtworkUrl}
                        aria-hidden="true"
                      />
                      <span className="return-video-veil" aria-hidden="true" />
                      <span className="card-index">{card.roman} · {card.name}</span>
                      <span className="card-name">{card.name}</span>
                    </span>
                    <canvas className="card-front-diffraction-canvas" aria-hidden="true" />
                    <canvas className="shader-canvas" aria-hidden="true" />
                  </span>
                </span>
                <span className="card-reveal-prompt" aria-label={REVEAL_PROMPT}>
                  <span className="card-reveal-copy" aria-hidden="true">
                    {[...REVEAL_PROMPT].map((character, index) => (
                      <span
                        key={`${character}-${index}`}
                        className={`card-reveal-character${character === " " ? " is-space" : ""}`}
                        style={{ "--character-index": index }}
                      >
                        {character === " " ? "\u2009" : character}
                      </span>
                    ))}
                  </span>
                </span>
              </span>
            </button>
          </div>
        </div>

        <article className="reading-copy">
          <div className="reading-stack">
            <header>
              <p className="reading-kicker">{card.roman} · Today's themes / {card.themes.join(" · ")}</p>
              <h2 className="reading-title">{card.name}</h2>
            </header>
            <p className="reading-lead">{card.lead}</p>
            <ul className="tips">
              {card.tips.map((tip, index) => <li key={tip} data-index={String(index + 1).padStart(2, "0")}>{tip}</li>)}
            </ul>
            <div className="speech-line">
              <span className="voice-bars" aria-hidden="true"><i /><i /><i /></span>
              <span data-speech-label="">Preparing the reading</span>
            </div>
            <DuplexComposer variantId={variantId} spatius={spatius} card={card} />
          </div>
        </article>
      </div>
      <span id="full-card-instructions" className="visually-hidden">
        Full card artwork. Press Escape or click outside the card to close.
      </span>
    </section>
  );
}

function ArchiveCard({ card, index, collected }) {
  const { roman, name } = card;
  return (
    <button
      className="archive-card"
      data-card-id={card.id}
      data-card-index={index}
      data-collected={collected ? "" : undefined}
      aria-label={`${name}, ${collected ? "collected" : "not yet collected"}`}
    >
      <span className="archive-card-inner">
        <img
          className="archive-card-artwork"
          src={card.composition.thumbnailArtworkUrl}
          alt=""
          width="512"
          height="820"
          loading="lazy"
          decoding="async"
          draggable="false"
        />
        <span className="archive-roman">{roman}</span>
        <span className="archive-name">{collected ? name : "Not yet awakened"}</span>
      </span>
    </button>
  );
}

export function ArchiveView() {
  const [collectedIndexes, setCollectedIndexes] = useState(getCollectedIndexSet);
  const [ready, setReady] = useState(false);
  const sectionRef = useRef(null);

  useEffect(() => {
    const refresh = () => setCollectedIndexes(getCollectedIndexSet());
    window.addEventListener(COLLECTION_CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(COLLECTION_CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    const root = sectionRef.current?.closest(".variant-app");
    if (!root) return undefined;
    const revealWhenActive = () => {
      if (root.dataset.view === "archive") setReady(true);
    };
    revealWhenActive();
    const observer = new MutationObserver(revealWhenActive);
    observer.observe(root, { attributes: true, attributeFilter: ["data-view"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!ready) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const root = sectionRef.current?.closest(".variant-app");
      if (root) window.LIVING_ARCANA_ENGINE?.layoutArchive?.(root);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ready]);

  return (
    <section ref={sectionRef} className="scene archive-view" aria-label="Major Arcana card library">
      <div className="archive-meta"><h1>Major Arcana</h1><p>{String(collectedIndexes.size).padStart(2, "0")} / 22 awakened</p></div>
      <div className="archive-webgl-stage">
        <canvas className="archive-webgl-canvas" tabIndex="0" aria-label="Interactive Major Arcana library. Drag horizontally to explore. Use arrow keys to move between cards and rows, and Enter to focus the current card." />
        <p className="archive-webgl-help">Drag either row · Select a card</p>
        <p className="archive-webgl-status" role="status" aria-live="polite" />
      </div>
      <div className="archive-arc">{ready ? TAROT_CARDS.map((card, index) => <ArchiveCard key={card.id} card={card} index={index} collected={collectedIndexes.has(index)} />) : null}</div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-group"><button className="footer-link" data-action="legal">Privacy &amp; Compliance</button><span>© 2026 Living Arcana</span></div>
      <div className="footer-group footer-release">
        <MotionToggle />
        <button className="footer-link footer-changelog-link" data-action="changelog">v{APP_VERSION} · Changelog</button>
        <span className="footer-credit">Made with 💜 by Rowan</span>
      </div>
    </footer>
  );
}

export function Overlays({ variantId }) {
  return (
    <>
      <div className="overlay archive-focus-overlay" role="dialog" aria-modal="true" aria-label="Card library preview" aria-hidden="true" inert>
        <div className="overlay-panel archive-focus-panel">
          <button className="focus-card-button" data-action="focus-flip" aria-label="Flip card">
            <span className="focus-card-tilt">
              <span className="focus-flipper">
                <span className="focus-face focus-back">
                  <canvas className="focus-back-metal-canvas" aria-hidden="true" />
                  <span className="back-mark">A</span>
                </span>
                <span className="focus-face focus-front">
                  <img className="focus-card-artwork" data-archive-focus-artwork="" alt="" width="1000" height="1600" draggable="false" />
                  <video className="focus-card-video" data-archive-focus-video="" muted loop playsInline preload="metadata" aria-hidden="true" />
                  <canvas className="focus-front-diffraction-canvas" aria-hidden="true" />
                  <span className="focus-card-index" data-archive-focus-index="" />
                  <span className="focus-card-name" data-archive-focus-name="" />
                </span>
              </span>
            </span>
          </button>
          <p className="focus-caption">Click the card to flip · Click outside to close</p>
        </div>
      </div>

      <div className="overlay legal-overlay" role="dialog" aria-modal="true" aria-labelledby={`legal-title-${variantId}`} aria-hidden="true" inert>
        <div className="overlay-panel legal-panel">
          <button className="overlay-close" data-action="close-overlay" aria-label="Close">×</button>
          <h2 id={`legal-title-${variantId}`}>Privacy &amp; Compliance</h2>
          <p>This experience is intended for reflection and entertainment. It does not provide medical, legal, financial, or other professional advice, and it does not promise to predict the future.</p>
          <p>Your questions are sent through our server to OpenRouter, which routes them to an AI model provider that generates the card's answer; answers may be sent to ElevenLabs to synthesize the card's voice. When you speak, your microphone audio is transcribed into text — streamed to OpenAI during a live conversation, or sent through OpenRouter as a short recording otherwise. The digital human is rendered through a Spatius session.</p>
          <p>We do not store your questions, recordings, or answers on our server. To enforce the daily limits for Today's card and Three Cards, we keep an anonymous browser identifier and separate daily counts; no question text is attached to either record. Your daily card, collection progress, and interface preferences are kept only in this browser's local storage. OpenRouter, the model providers it routes to, OpenAI, ElevenLabs, and Spatius process your data according to their own policies.</p>
        </div>
      </div>

      <div className="overlay changelog-overlay" role="dialog" aria-modal="true" aria-labelledby={`changelog-title-${variantId}`} aria-hidden="true" inert>
        <div className="overlay-panel legal-panel changelog-panel">
          <button className="overlay-close" data-action="close-overlay" aria-label="Close">×</button>
          <p className="changelog-kicker">Living Arcana · v{APP_VERSION}</p>
          <h2 id={`changelog-title-${variantId}`}>Changelog</h2>
          <div className="changelog-list">
            {CHANGELOG.map((release) => (
              <article className="changelog-entry" key={release.version}>
                <header>
                  <h3>v{release.version}</h3>
                  <time dateTime={release.date}>{release.label}</time>
                </header>
                {release.changes.map((change) => <p key={change}>{change}</p>)}
              </article>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
