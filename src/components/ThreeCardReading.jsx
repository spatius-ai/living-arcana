import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fallbackTarotAnswer, recordCardCollected, SELECTED_DIRECTION, TAROT_CARDS } from "../data/tarot.js";
import { createDualFaceCardMaterial } from "../dualFaceCardMaterial.js";
import { ACTIVATION_SHADER_DURATION, runActivationShader } from "../motion/runActivationShader.js";
import { requestWithRetry } from "../reading/requestWithRetry.js";
import { clearThreeCardSession, readThreeCardSession, writeThreeCardSession } from "../reading/threeCardSession.js";
import { findSentenceEnd, readArcanaAnswerResponse } from "../duplex/arcanaAnswerStream.js";
import { createAnswerRevealer, PCM_BYTES_PER_MS } from "../duplex/answerRevealer.js";
import { createSentenceSpeechPump } from "../duplex/sentenceSpeechPump.js";
import {
  backgroundMusic,
  BACKGROUND_MUSIC_RECORDING_DUCK,
  BACKGROUND_MUSIC_SPEECH_DUCK,
} from "../audio/backgroundMusic.js";
import { runUISFXTask, uiSfx } from "../audio/uiSfx.js";
import BlurReveal from "./BlurReveal.jsx";
import CelestialSealButton from "./CelestialSealButton.jsx";
import {
  ReadingLog,
  ReadingLogContent,
  ReadingLogReading,
  ReadingLogTrigger,
  ReadingLogTurn,
} from "./ReadingLog.jsx";
import {
  ReadingComposer,
  ReadingComposerActions,
  ReadingComposerField,
  ReadingComposerForm,
  ReadingComposerHeader,
  ReadingComposerSend,
  ReadingComposerSpeaker,
  ReadingComposerVoice,
} from "./ReadingComposer.jsx";
import ShimmerText from "./ShimmerText.jsx";
import "./ThreeCardReading.css";
import { fetchWithTimeout } from "../reading/fetchWithTimeout.js";

const QUESTION_LIMIT = 180;
const FOLLOWUP_LIMIT = 160;
const DRAW_STAR_SOUND_PEAK_DELAY_MS = 286;
const LIVE_ANSWER_ATTEMPTS = 2;
const LIVE_ANSWER_TIMEOUT_MS = 18_000;
const SPEECH_DRAIN_TIMEOUT_MS = 20_000;
const THREE_CARD_QUESTION_QUOTA_PATH = "/api/arcana/three-card-quota";
// Uploading and transcribing up to 30 s of audio can legitimately take a while.
const TRANSCRIBE_TIMEOUT_MS = 45_000;

function createConsultationId() {
  return window.crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeDailyQuota(payload) {
  const limit = Number(payload?.limit);
  const used = Number(payload?.used);
  const remaining = Number(payload?.remaining);
  if (!Number.isInteger(limit) || !Number.isInteger(used) || !Number.isInteger(remaining)) return null;
  if (limit < 1 || used < 0 || remaining < 0 || used + remaining !== limit) return null;
  return {
    status: remaining === 0 ? "exhausted" : "ready",
    limit,
    used,
    remaining,
    resetAt: typeof payload?.resetAt === "string" ? payload.resetAt : "",
  };
}

function isLiveAnswerPayload(payload) {
  return payload?.source === "llm"
    || (payload?.source === "spatius-easter-egg" && payload?.live === true);
}

const POSITIONS = Object.freeze([
  { id: "signal", label: "Signal", description: "What wants your attention" },
  { id: "tension", label: "Tension", description: "What complicates the question" },
  { id: "move", label: "Move", description: "What you can try next" },
]);

const icons = {
  mic: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="8.25" y="3" width="7.5" height="12" rx="3.75" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="m5 12 14-7-4 14-3-5-7-2Z" />
      <path d="m12 14 7-9" />
    </svg>
  ),
  finish: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="m6.5 12.5 3.5 3.5 7.5-8" />
    </svg>
  ),
};

function randomIndex(max) {
  if (max <= 1) return 0;
  const range = 0x100000000;
  const limit = range - (range % max);
  const value = new Uint32Array(1);
  do window.crypto.getRandomValues(value); while (value[0] >= limit);
  return value[0] % max;
}

function drawThreeCards() {
  const pool = [...TAROT_CARDS];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }
  return pool.slice(0, 3).map((card, index) => ({ card, position: POSITIONS[index] }));
}

function restoreThreeCardSpread(session) {
  if (!session) return null;
  const restored = session.spread.map(({ cardId, positionId }) => ({
    card: TAROT_CARDS.find((card) => card.id === cardId),
    position: POSITIONS.find((position) => position.id === positionId),
  }));
  if (restored.some((entry) => !entry.card || !entry.position)) return null;
  if (restored.some((entry) => typeof session.answers?.[entry.card.id] !== "string" || !session.answers[entry.card.id].trim())) return null;
  const selectedId = restored.some((entry) => entry.card.id === session.selectedId) ? session.selectedId : "";
  return {
    ...session,
    spread: restored,
    selectedId,
    phase: session.phase === "consultation" && selectedId ? "consultation" : "spread",
  };
}

function waitForDrain(promise, timeoutMs) {
  let timeout;
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => { timeout = window.setTimeout(() => resolve(false), timeoutMs); }),
  ]).finally(() => window.clearTimeout(timeout));
}

function firstSentence(text) {
  const match = String(text || "").trim().match(/^.*?[.!?。！？](?:\s|$)/);
  return (match?.[0] || text || "").trim();
}

const THIRD_PERSON_VERBS = {
  ask: "asks",
  bring: "brings",
  complicate: "complicates",
  draw: "draws",
  encourage: "encourages",
  invite: "invites",
  notice: "notices",
  point: "points",
  recommend: "recommends",
  reveal: "reveals",
  see: "sees",
  show: "shows",
  suggest: "suggests",
  urge: "urges",
};

function thirdPersonSummary(entry, text) {
  const name = entry.card.name;
  let summary = firstSentence(text);

  if (!summary) return "";

  summary = summary
    .replace(/\bI can(?:not|'t|’t)\b/gi, `${name} cannot`)
    .replace(/\bI am\b/gi, `${name} is`)
    .replace(/\bI(?:'m|’m)\b/gi, `${name} is`)
    .replace(/\bI have\b/gi, `${name} has`)
    .replace(/\bI(?:'ve|’ve)\b/gi, `${name} has`)
    .replace(/\bI do not\b/gi, `${name} does not`)
    .replace(
      /\bI (ask|bring|complicate|draw|encourage|invite|notice|point|recommend|reveal|see|show|suggest|urge)\b/gi,
      (_, verb) => `${name} ${THIRD_PERSON_VERBS[verb.toLowerCase()]}`,
    )
    .replace(/\bI\b/g, name)
    .replace(/\bmy\b/gi, `${name}’s`)
    .replace(/\bme\b/gi, name);

  if (!summary.toLowerCase().startsWith(name.toLowerCase())) {
    summary = `${name} suggests: ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`;
  }

  return summary;
}

function makeReadingContext({ originalQuestion, entry, consultationId, followup = false }) {
  return {
    mode: followup ? "three-card-followup" : "three-card-initial",
    originalQuestion: originalQuestion.slice(0, QUESTION_LIMIT),
    position: entry.position.id,
    consultationId,
  };
}

async function askCard({ originalQuestion, entry, consultationId, followup, signal }) {
  const response = await fetch("/api/arcana/ask", {
    method: "POST",
    credentials: "same-origin",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      cardId: entry.card.id,
      question: followup || originalQuestion,
      readingContext: makeReadingContext({ originalQuestion, entry, consultationId, followup: Boolean(followup) }),
      voice: false,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Reading request failed (${response.status}).`);
  const payload = await response.json();
  if (!isLiveAnswerPayload(payload) || typeof payload?.answer !== "string" || !payload.answer.trim()) {
    const error = new Error(payload?.source === "curated"
      ? "The live reading service returned curated fallback content."
      : "The live reading service returned an invalid response.");
    error.code = payload?.source === "curated" ? "curated_fallback" : "invalid_response";
    error.fallbackAnswer = typeof payload?.answer === "string" ? payload.answer.trim() : "";
    throw error;
  }
  return payload.answer.trim();
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function useThreeCardMaterial({
  targetRef,
  tiltRef,
  frontCanvasRef,
  backCanvasRef,
  side,
  artworkUrl,
  active,
  reducedMotion,
}) {
  const controllerRef = useRef(null);
  const sideRef = useRef(side);
  const activeRef = useRef(active);
  sideRef.current = side;
  activeRef.current = active;

  useEffect(() => {
    const target = targetRef.current;
    const tilt = tiltRef.current;
    if (!target || !tilt) return undefined;
    const root = target.closest(".variant-app");
    const controller = createDualFaceCardMaterial({
      target,
      tilt,
      frontCanvas: frontCanvasRef.current,
      backCanvas: backCanvasRef?.current || null,
      getSide: () => sideRef.current,
      getFrontArtworkUrl: () => artworkUrl,
      getStrength: () => {
        const value = Number.parseFloat(getComputedStyle(root).getPropertyValue("--home-holographic-strength"));
        return Number.isFinite(value) ? value : 0.68;
      },
      enabled: () => activeRef.current,
      maxTilt: 2.7,
      reducedMotion,
    });
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
  }, [artworkUrl, backCanvasRef, frontCanvasRef, reducedMotion, targetRef, tiltRef]);

  useEffect(() => {
    controllerRef.current?.sync();
    if (!active) controllerRef.current?.reset({ immediate: true });
  }, [active, side]);
}

function isExtremeWeakNetwork() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return Boolean(connection?.saveData || connection?.effectiveType === "slow-2g");
}

// Every prop is a primitive, a ref or a stable spread entry, so memo lets the
// streamed answer text (a state update per revealed chunk) re-render its own
// paragraph without reconciling the card's artwork, avatar layers and canvas.
const CardMedia = memo(function CardMedia({
  entry,
  animated = false,
  avatarReady = false,
  avatarFallback = false,
  avatarHostRef,
  reducedMotion = false,
  className = "",
}) {
  const activationCanvasRef = useRef(null);
  const { backgroundTransform, frame, overlayTransform } = entry.card.composition;
  const showAvatar = animated && avatarReady && !avatarFallback;

  useEffect(() => {
    if (!showAvatar || reducedMotion) return undefined;
    let active = true;
    const stop = runActivationShader(
      activationCanvasRef.current,
      SELECTED_DIRECTION.shader,
      ACTIVATION_SHADER_DURATION,
      { active: () => active },
    );
    return () => {
      active = false;
      stop();
    };
  }, [entry.card.id, reducedMotion, showAvatar]);

  return (
    <span
      className={`three-card-media${showAvatar ? " is-avatar-visible" : ""}${className ? ` ${className}` : ""}`}
      data-card-id={entry.card.id}
    >
      <img src={entry.card.composition.libraryArtworkUrl} alt={entry.card.name} width="1000" height="1600" decoding="async" draggable="false" />
      <span className="three-card-face-labels" aria-hidden="true">
        <span>{entry.card.roman} · {showAvatar ? "Spatius awakened" : "Major Arcana"}</span>
        <span>{entry.card.name}</span>
      </span>
      <span className="three-card-avatar-layer" aria-hidden="true">
        <span
          className="three-card-avatar-background"
          style={{
            backgroundImage: `url(${entry.card.composition.backgroundUrl})`,
            "--three-card-avatar-background-x": `${backgroundTransform.x}%`,
            "--three-card-avatar-background-y": `${backgroundTransform.y}%`,
            "--three-card-avatar-background-scale": backgroundTransform.scale,
            opacity: entry.card.composition.backgroundOpacity,
          }}
        />
        <span
          ref={avatarHostRef}
          className="three-card-avatar-host"
          style={{
            "--three-card-avatar-frame-x": `${frame.x}%`,
            "--three-card-avatar-frame-y": `${frame.y}%`,
            "--three-card-avatar-frame-width": `${frame.width}%`,
            "--three-card-avatar-frame-height": `${frame.height}%`,
          }}
        />
        {entry.card.composition.overlayUrl ? (
          <span
            className="three-card-avatar-overlay"
            style={{
              backgroundImage: `url(${entry.card.composition.overlayUrl})`,
              "--three-card-avatar-overlay-x": `${overlayTransform.x}%`,
              "--three-card-avatar-overlay-y": `${overlayTransform.y}%`,
              "--three-card-avatar-overlay-scale": overlayTransform.scale,
              opacity: entry.card.composition.overlayOpacity,
            }}
          />
        ) : null}
      </span>
      <canvas ref={activationCanvasRef} className="three-card-activation-canvas" aria-hidden="true" />
    </span>
  );
});

function StarMeter({ remaining, label, showTooltip = false, tooltipId }) {
  const statusLabel = label || `${remaining} question${remaining === 1 ? "" : "s"} left`;
  return (
    <span
      className={`three-card-stars${showTooltip ? " has-tooltip" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={statusLabel}
      aria-describedby={showTooltip ? tooltipId : undefined}
      tabIndex={showTooltip ? 0 : undefined}
    >
      <span className="three-card-star-glyphs" aria-hidden="true">
        {[1, 2, 3].map((value) => <i key={value} className={remaining >= value ? "is-lit" : ""}>✦</i>)}
      </span>
      {showTooltip ? (
        <span className="three-card-stars-tooltip" id={tooltipId} role="tooltip">{statusLabel}</span>
      ) : null}
    </span>
  );
}

function DrawProgressDock({ filled, onSkip }) {
  const complete = filled >= 3;
  return (
    <section
      className={`three-card-followup is-drawing${complete ? " is-filled" : ""}`}
      aria-label={complete ? "Three cards revealed" : `Drawing card ${filled + 1} of 3`}
    >
      <div className="three-card-draw-heading">
        <span>
          <small>{complete ? "Spread complete" : "Drawing your spread"}</small>
          <b>{complete ? "Three voices are ready" : "Let each card finish speaking"}</b>
        </span>
        <button className="footer-link" type="button" onClick={onSkip}>
          {complete ? "Open the spread" : "Skip to the spread"}
        </button>
      </div>
      <div className="three-card-draw-well">
        <span>{complete ? "Your follow-up space is opening…" : "Each revealed card leaves a star"}</span>
        <StarMeter remaining={filled} label={`${filled} of 3 cards revealed`} />
      </div>
    </section>
  );
}

function SpreadRail({ spread, discovered, selectedId, disabled, slotRefs, highlightedId, onHover, onSelect }) {
  return (
    <nav className={`three-card-rail${highlightedId ? " has-highlight" : ""}`} aria-label="Three-card spread">
      {spread.map((entry, index) => {
        const visible = index < discovered;
        const selected = entry.card.id === selectedId;
        return (
          <button
            key={`${entry.position.id}-${entry.card.id}`}
            type="button"
            className={`three-card-rail-card${visible ? " is-visible" : ""}${selected ? " is-selected" : ""}${highlightedId === entry.card.id ? " is-highlighted" : ""}`}
            aria-label={visible ? `${entry.position.label} ${entry.card.name}` : `${entry.position.label} card waiting`}
            aria-pressed={selected}
            disabled={!visible || disabled}
            onMouseEnter={() => { if (visible && !disabled) onHover?.(entry.card.id); }}
            onMouseLeave={() => onHover?.("")}
            onFocus={() => { if (visible && !disabled) onHover?.(entry.card.id); }}
            onBlur={() => onHover?.("")}
            onClick={(event) => onSelect?.(entry, { animate: event.detail !== 0 })}
          >
            <span
              ref={(node) => { slotRefs.current[index] = node; }}
              className="three-card-rail-slot"
              aria-hidden="true"
            >
              {visible ? <img src={entry.card.composition.libraryArtworkUrl} alt="" width="1000" height="1600" decoding="async" draggable="false" /> : <i>{String(index + 1).padStart(2, "0")}</i>}
              <span className="three-card-rail-label">{entry.position.label}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export function Entry({ active, question, setQuestion, onSubmit, quota, starting, onRetryQuota }) {
  const ready = quota.status === "ready";
  const exhausted = quota.status === "exhausted";
  return (
    <div className={`three-card-entry landing-content${active ? " is-visible" : ""}`}>
      <BlurReveal
        as="h1"
        className="landing-cta"
        trigger={active}
        delay={0.18}
        blur={12}
        yOffset={10}
        stagger={0.027}
        duration={0.68}
        aria-live={exhausted ? "polite" : undefined}
      >
        {exhausted
          ? "The cards have answered today’s three questions—come back tomorrow."
          : "Begin with a question.\nThe cards take it from here."}
      </BlurReveal>
      {!exhausted ? <p>Bring a question you’ve been carrying. Let three cards speak to it. Notice which voice stays with you.</p> : null}
      {ready ? (
        <form className="three-card-question-form" onSubmit={onSubmit} aria-busy={starting}>
          <label>
            <span className="sr-only">Your question</span>
            <input
              className="qa-input"
              type="text"
              name="question"
              maxLength={QUESTION_LIMIT}
              autoComplete="off"
              spellCheck="false"
              placeholder="Write the question you’ve been carrying…"
              value={question}
              disabled={starting}
              onChange={(event) => {
                setQuestion(event.target.value);
                uiSfx.play("typing", { volume: 0.16, cooldownMs: 0 });
              }}
            />
          </label>
          <CelestialSealButton type="submit" disabled={starting || !question.trim()}>
            {starting ? "Beginning…" : "Begin the reading"}
          </CelestialSealButton>
        </form>
      ) : null}
      {quota.status === "loading" ? (
        <p className="three-card-quota-state" role="status">Reading today’s sky…</p>
      ) : null}
      {quota.status === "unavailable" ? (
        <div className="three-card-quota-state is-unavailable" role="status">
          <p>The cards cannot open a new reading right now.</p>
          <button type="button" onClick={onRetryQuota}>Try again</button>
        </div>
      ) : null}
      {ready ? <small><span aria-hidden="true">✦</span> Three cards · Three follow-up questions · About two minutes</small> : null}
    </div>
  );
}

function ThreeCardReadingLog({ open, onOpenChange, entry, answer, answerReady, messages = [] }) {
  const panelId = `three-card-log-${entry.position.id}-${entry.card.id}`;
  return (
    <ReadingLog open={open} onOpenChange={onOpenChange}>
      <ReadingLogTrigger
        className="three-card-log-trigger"
        aria-label={`Open reading log for ${entry.card.name}`}
        aria-controls={panelId}
      />
      <ReadingLogContent id={panelId} className="three-card-log-dialog" title={entry.card.name}>
        <ReadingLogReading label={`${entry.position.label} · ${entry.card.themes[0]}`}>
          <p>{answerReady ? answer : <ShimmerText>Considering your question…</ShimmerText>}</p>
        </ReadingLogReading>
        {messages.map((message) => (
          <ReadingLogTurn
            key={message.id}
            question={message.question}
            answerLabel={entry.card.name}
            answer={message.pending ? <ShimmerText>Considering…</ShimmerText> : message.answer}
            pending={message.pending}
          />
        ))}
      </ReadingLogContent>
    </ReadingLog>
  );
}

function ReadingSequence({ entry, stage, answer, answerReady, cardRef, avatarHostRef, avatarReady, avatarFallback, active, reducedMotion }) {
  const [logOpen, setLogOpen] = useState(false);
  const speaking = ["awaken", "speaking"].includes(stage);
  const tiltRef = useRef(null);
  const frontCanvasRef = useRef(null);
  const backCanvasRef = useRef(null);
  useEffect(() => setLogOpen(false), [entry.card.id]);
  useThreeCardMaterial({
    targetRef: cardRef,
    tiltRef,
    frontCanvasRef,
    backCanvasRef,
    side: stage === "summon" ? "back" : "front",
    artworkUrl: entry.card.composition.libraryArtworkUrl,
    active,
    reducedMotion,
  });
  return (
    <div className="three-card-reading-sequence" data-stage={stage}>
      <div className="three-card-mobile-card-page">
        <div ref={cardRef} className="three-card-stage-card">
          <span ref={tiltRef} className="three-card-stage-tilt">
            <span className="three-card-stage-flipper">
              <span className="three-card-stage-face three-card-stage-back">
                <canvas ref={backCanvasRef} className="three-card-back-metal-canvas" aria-hidden="true" />
              </span>
              <span className="three-card-stage-face three-card-stage-front">
                <CardMedia
                  entry={entry}
                  animated={speaking}
                  avatarReady={avatarReady}
                  avatarFallback={avatarFallback}
                  avatarHostRef={avatarHostRef}
                  reducedMotion={reducedMotion}
                />
                <canvas ref={frontCanvasRef} className="three-card-front-diffraction-canvas" aria-hidden="true" />
              </span>
            </span>
          </span>
        </div>
      </div>
      <article className="three-card-verdict">
        <p>{entry.position.label} · {entry.card.themes[0]}</p>
        <h2>{entry.card.name}</h2>
        <blockquote>{answerReady ? answer : <ShimmerText>Considering your question…</ShimmerText>}</blockquote>
      </article>
      <ThreeCardReadingLog
        open={logOpen}
        onOpenChange={setLogOpen}
        entry={entry}
        answer={answer}
        answerReady={answerReady}
      />
    </div>
  );
}

function SpreadSummary({ spread, answers, answerReady, highlightedId, onHover, onSelect }) {
  const overall = `The spread moves from ${spread[0].card.themes[0].toLowerCase()}, through ${spread[1].card.themes[0].toLowerCase()}, toward ${spread[2].card.themes[0].toLowerCase()}—let the next step hold all three.`;
  return (
    <section className="three-card-spotlight-stage is-summary" aria-label="Spread summary">
      <article className="three-card-voice">
        <div className="three-card-summary-intro">
          <p className="three-card-eyebrow">Spread summary</p>
          <h2>Choose a card</h2>
          <p className="three-card-overall"><span>Overall</span>{overall}</p>
        </div>
        <div className={`three-card-summary-lines${highlightedId ? " has-highlight" : ""}`}>
          {spread.map((entry) => (
            <button
              key={entry.card.id}
              type="button"
              className={highlightedId === entry.card.id ? "is-highlighted" : ""}
              onMouseEnter={() => onHover(entry.card.id)}
              onMouseLeave={() => onHover("")}
              onFocus={() => onHover(entry.card.id)}
              onBlur={() => onHover("")}
              onClick={(event) => onSelect(entry, { animate: event.detail !== 0 })}
            >
              <span>{entry.position.label}</span>
              <p>
                {answerReady[entry.card.id]
                  ? thirdPersonSummary(entry, answers[entry.card.id])
                  : <ShimmerText>Considering…</ShimmerText>}
              </p>
            </button>
          ))}
        </div>
      </article>
    </section>
  );
}

function ConsultationStage({ entry, answer, answerReady, messages, targetRef, avatarHostRef, avatarReady, avatarFallback, active, reducedMotion }) {
  const [logOpen, setLogOpen] = useState(false);
  const tiltRef = useRef(null);
  const frontCanvasRef = useRef(null);
  const readingScrollRef = useRef(null);
  const followLatestRef = useRef(true);
  const latestMessageIdRef = useRef("");
  const [scrollCue, setScrollCue] = useState({ overflowing: false, scrolled: false });
  useEffect(() => setLogOpen(false), [entry.card.id]);
  const updateScrollCue = useCallback((readingScroll) => {
    if (!readingScroll) return;
    const next = {
      overflowing: readingScroll.scrollHeight > readingScroll.clientHeight + 1,
      scrolled: readingScroll.scrollTop > 3,
    };
    setScrollCue((current) => (
      current.overflowing === next.overflowing && current.scrolled === next.scrolled ? current : next
    ));
  }, []);
  useThreeCardMaterial({
    targetRef,
    tiltRef,
    frontCanvasRef,
    side: "front",
    artworkUrl: entry.card.composition.libraryArtworkUrl,
    active,
    reducedMotion,
  });
  useLayoutEffect(() => {
    const readingScroll = readingScrollRef.current;
    if (!readingScroll) return undefined;
    const frame = window.requestAnimationFrame(() => updateScrollCue(readingScroll));
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => updateScrollCue(readingScroll))
      : null;
    observer?.observe(readingScroll);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [answer, entry.card.id, messages, updateScrollCue]);
  useEffect(() => {
    const readingScroll = readingScrollRef.current;
    const latestMessageId = messages.at(-1)?.id || "";
    if (!readingScroll || !latestMessageId) {
      latestMessageIdRef.current = "";
      followLatestRef.current = true;
      return undefined;
    }
    const isNewMessage = latestMessageIdRef.current !== latestMessageId;
    latestMessageIdRef.current = latestMessageId;
    if (isNewMessage) followLatestRef.current = true;
    if (!followLatestRef.current) return undefined;
    const frame = window.requestAnimationFrame(() => {
      readingScroll.scrollTo({
        top: readingScroll.scrollHeight,
        behavior: isNewMessage && !reducedMotion ? "smooth" : "auto",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entry.card.id, messages, reducedMotion]);
  return (
    <section className="three-card-spotlight-stage is-consultation" aria-label={`Current card: ${entry.card.name}`}>
      <div className="three-card-mobile-card-page">
        <div ref={targetRef} className="three-card-spotlight-art">
          <span ref={tiltRef} className="three-card-spotlight-material">
            <CardMedia
              entry={entry}
              animated
              avatarReady={avatarReady}
              avatarFallback={avatarFallback}
              avatarHostRef={avatarHostRef}
              reducedMotion={reducedMotion}
            />
            <canvas ref={frontCanvasRef} className="three-card-front-diffraction-canvas" aria-hidden="true" />
          </span>
        </div>
      </div>
      <article className="three-card-voice">
        <header className="three-card-voice-header">
          <p className="three-card-eyebrow">{entry.position.label} · {entry.card.themes[0]}</p>
          <h2>{entry.card.name}</h2>
        </header>
        <div
          className="three-card-reading-scroll-shell"
          data-overflowing={scrollCue.overflowing ? "" : undefined}
          data-scrolled={scrollCue.scrolled ? "" : undefined}
        >
          <div
            className="three-card-reading-scroll"
            role="region"
            aria-label={`Reading and conversation with ${entry.card.name}`}
            tabIndex={0}
            ref={readingScrollRef}
            onScroll={(event) => {
              const readingScroll = event.currentTarget;
              const distanceFromBottom = readingScroll.scrollHeight - readingScroll.scrollTop - readingScroll.clientHeight;
              followLatestRef.current = distanceFromBottom < 48;
              updateScrollCue(readingScroll);
            }}
          >
            <blockquote>{answerReady ? answer : <ShimmerText>Considering your question…</ShimmerText>}</blockquote>
            {messages.length ? (
              <div className="three-card-thread" aria-label={`Conversation with ${entry.card.name}`}>
                {messages.map((message) => (
                  <div key={message.id}>
                    <p><span>You</span>{message.question}</p>
                    <p className={`is-card-answer${message.pending ? " is-pending" : ""}`}>
                      <span>{entry.card.name}</span>
                      {message.pending ? <ShimmerText>Considering…</ShimmerText> : message.answer}
                    </p>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </article>
      <ThreeCardReadingLog
        open={logOpen}
        onOpenChange={setLogOpen}
        entry={entry}
        answer={answer}
        answerReady={answerReady}
        messages={messages}
      />
    </section>
  );
}

function FollowupComposer({ spread, selected, remaining, draft, setDraft, submitting, recording, status, onSubmit, onSelectPrompt, onRecord, onEnd, continuing = false }) {
  if (selected && remaining === 0 && !submitting) {
    return (
      <section className={`three-card-followup is-complete${continuing ? " is-continuation" : ""}`} aria-label="Reading complete">
        <span aria-hidden="true">✦</span>
        <div><b>Reading complete</b><p>The final reply remains with {selected.card.name}.</p></div>
        <button className="footer-link" type="button" onClick={onEnd}>Start over</button>
      </section>
    );
  }

  return (
    <ReadingComposer className={`${selected ? "" : "is-awaiting"}${continuing ? `${selected ? "" : " "}is-continuation` : ""}`} aria-label={selected ? `Ask ${selected.card.name}` : "Choose a card before asking a follow-up"}>
      <ReadingComposerHeader>
        <ReadingComposerSpeaker>
          <i
            aria-hidden="true"
          >{selected ? <img src={selected.card.composition.libraryArtworkUrl} alt="" width="1000" height="1600" /> : "✦"}</i>
          {selected ? `Ask ${selected.card.name}` : "Choose a card to ask"}
        </ReadingComposerSpeaker>
        {selected ? (
          <span role="status" aria-live="polite">
            {status === "Considering" ? <ShimmerText>Considering…</ShimmerText> : status}
          </span>
        ) : null}
        <ReadingComposerActions>
          <StarMeter remaining={remaining} showTooltip tooltipId="followup-questions-tooltip" />
          <button
            className="three-card-finish-button"
            type="button"
            aria-label="End the entire tarot Q&A and start a new one"
            onClick={onEnd}
          >
            {icons.finish}
            <span className="three-card-finish-label-full">End tarot Q&amp;A</span>
            <span className="three-card-finish-label-compact">End Q&amp;A</span>
          </button>
        </ReadingComposerActions>
      </ReadingComposerHeader>
      <ReadingComposerForm onSubmit={onSubmit}>
        <ReadingComposerVoice
          aria-label={selected ? (recording ? "Finish voice question" : "Ask by voice") : "Choose a card first"}
          aria-pressed={recording}
          disabled={!selected || submitting || remaining === 0}
          onClick={onRecord}
        >
          {icons.mic}<span>Voice</span>
        </ReadingComposerVoice>
        <ReadingComposerField>
          <span className="sr-only">{selected ? `Your question for ${selected.card.name}` : "Choose a card first"}</span>
          <input
            className="qa-input"
            maxLength={FOLLOWUP_LIMIT}
            autoComplete="off"
            spellCheck="false"
            placeholder={selected ? `Ask ${selected.card.name}…` : "Select a card from the spread to begin…"}
            value={draft}
            disabled={!selected || submitting || remaining === 0}
            onChange={(event) => {
              setDraft(event.target.value);
              uiSfx.play("typing", { volume: 0.16, cooldownMs: 0 });
            }}
          />
        </ReadingComposerField>
        <ReadingComposerSend aria-label={selected ? `Send question to ${selected.card.name}` : "Choose a card first"} disabled={!selected || !draft.trim() || submitting || remaining === 0}>
          {icons.send}
        </ReadingComposerSend>
      </ReadingComposerForm>
      <div className="three-card-prompts" aria-label="Suggested questions">
        {spread.map((entry) => (
          <button
            className="footer-link"
            key={entry.card.id}
            type="button"
            disabled={submitting || remaining === 0}
            aria-label={`Ask ${entry.card.name}: ${entry.card.question}`}
            onClick={() => onSelectPrompt(entry)}
          >
            <span>{entry.card.name.replace("The ", "")}</span>{entry.card.question}
          </button>
        ))}
      </div>
    </ReadingComposer>
  );
}

export default function ThreeCardReading({ spatius, getCardAvatarId = (card) => card.avatarId, todayCard }) {
  const reducedMotion = useReducedMotion();
  const initialSession = useMemo(() => {
    const restored = restoreThreeCardSpread(readThreeCardSession());
    if (!restored) clearThreeCardSession();
    return restored;
  }, []);
  const initialSpread = useMemo(() => initialSession?.spread || drawThreeCards(), [initialSession]);
  const initialAnswers = useMemo(
    () => Object.fromEntries(initialSpread.map((entry) => [entry.card.id, initialSession?.answers?.[entry.card.id] || ""])),
    [initialSession, initialSpread],
  );
  const restoredRemaining = Number(initialSession?.remaining ?? 3);
  const initialRemaining = Number.isInteger(restoredRemaining) ? Math.min(3, Math.max(0, restoredRemaining)) : 3;
  const [viewActive, setViewActive] = useState(false);
  const [entryHasEntered, setEntryHasEntered] = useState(Boolean(initialSession));
  const [question, setQuestion] = useState(initialSession?.question || "");
  const [consultationId, setConsultationId] = useState(() => initialSession?.consultationId || createConsultationId());
  const [phase, setPhase] = useState(initialSession?.phase || "question");
  const [spread, setSpread] = useState(initialSpread);
  const [answers, setAnswers] = useState(initialAnswers);
  const [revealedAnswers, setRevealedAnswers] = useState(initialAnswers);
  const [answerReady, setAnswerReady] = useState(() => Object.fromEntries(initialSpread.map((entry) => [entry.card.id, Boolean(initialAnswers[entry.card.id])])));
  const [readingIndex, setReadingIndex] = useState(0);
  const [readingStage, setReadingStage] = useState("summon");
  const [discovered, setDiscovered] = useState(initialSession ? 3 : 0);
  const [selectedId, setSelectedId] = useState(initialSession?.selectedId || "");
  const [highlightedId, setHighlightedId] = useState("");
  const [remaining, setRemaining] = useState(initialRemaining);
  const [threads, setThreads] = useState(initialSession?.threads || {});
  const [draft, setDraft] = useState(initialSession?.draft || "");
  const [dailyQuota, setDailyQuota] = useState({ status: "loading", limit: 3, used: 0, remaining: 0, resetAt: "" });
  const [quotaRefreshKey, setQuotaRefreshKey] = useState(0);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [composerReady, setComposerReady] = useState(Boolean(initialSession));
  const [status, setStatus] = useState("Ready");
  const [focusAnimating, setFocusAnimating] = useState(false);
  const [avatarReady, setAvatarReady] = useState(false);
  const [avatarFallback, setAvatarFallback] = useState(false);
  const sectionRef = useRef(null);
  const cardRef = useRef(null);
  const spotlightTargetRef = useRef(null);
  const avatarHostRef = useRef(null);
  const prewarmHostRef = useRef(null);
  const railSlotRefs = useRef([]);
  const prewarmKeyRef = useRef("");
  const avatarSwitchRun = useRef(0);
  const readingSpeechKey = useRef("");
  const sessionRun = useRef(0);
  const controllers = useRef(new Set());
  const followupRunRef = useRef(null);
  const recordingRef = useRef(null);
  // Bumped by every stop: a getUserMedia() still waiting on the permission
  // prompt has no recorder to stop yet, so it compares this after resolving.
  const recordRequestRef = useRef(0);
  const recordLimitTimer = useRef(0);
  const previousPhaseRef = useRef(initialSession?.phase || "question");
  const previousDiscoveredRef = useRef(initialSession ? 3 : 0);
  const previousRemainingRef = useRef(initialRemaining);

  const selected = useMemo(() => spread.find((entry) => entry.card.id === selectedId) || null, [selectedId, spread]);
  const activeEntry = phase === "reading" ? spread[readingIndex] : selected || spread[2];
  const cardAvatarPayload = useCallback((entry) => ({
    cardId: entry.card.id,
    avatarId: getCardAvatarId(entry.card) || undefined,
    transform: entry.card.composition.avatar,
    voiceId: entry.card.tts.voiceId || undefined,
    voiceSettings: {
      stability: entry.card.tts.stability,
      similarityBoost: entry.card.tts.similarityBoost,
      style: entry.card.tts.style,
      speed: entry.card.tts.speed,
    },
  }), [getCardAvatarId]);

  const abortRequests = useCallback(() => {
    controllers.current.forEach((controller) => controller.abort());
    controllers.current.clear();
    followupRunRef.current?.abort();
    followupRunRef.current = null;
  }, []);

  const stopRecording = useCallback(() => {
    recordRequestRef.current += 1;
    window.clearTimeout(recordLimitTimer.current);
    const active = recordingRef.current;
    if (!active) return;
    try { active.recorder.stop(); } catch { active.stream.getTracks().forEach((track) => track.stop()); }
  }, []);

  useEffect(() => () => {
    abortRequests();
    stopRecording();
    uiSfx.stopLoop("three-card-reading");
  }, [abortRequests, stopRecording]);

  useEffect(() => {
    const loopCue = recording ? "recording" : submitting ? "processing" : null;
    if (loopCue) uiSfx.startLoop("three-card-reading", loopCue);
    else uiSfx.stopLoop("three-card-reading");
    return () => uiSfx.stopLoop("three-card-reading");
  }, [recording, status, submitting]);

  useEffect(() => {
    const voiceActive = (phase === "reading" && readingStage === "speaking")
      || (submitting && status === "Speaking");
    const shouldDuck = viewActive && (recording || voiceActive);
    backgroundMusic.setDucked(
      "three-card-audio",
      shouldDuck,
      recording ? BACKGROUND_MUSIC_RECORDING_DUCK : BACKGROUND_MUSIC_SPEECH_DUCK,
    );
  }, [phase, readingStage, recording, status, submitting, viewActive]);

  useEffect(() => () => backgroundMusic.setDucked("three-card-audio", false), []);

  useLayoutEffect(() => {
    if (discovered > previousDiscoveredRef.current) {
      uiSfx.playStarAppear({ delayMs: reducedMotion ? 0 : DRAW_STAR_SOUND_PEAK_DELAY_MS });
    }
    previousDiscoveredRef.current = discovered;
  }, [discovered, reducedMotion]);

  useLayoutEffect(() => {
    if (remaining < previousRemainingRef.current) uiSfx.playStarDisappear();
    previousRemainingRef.current = remaining;
  }, [remaining]);

  useEffect(() => {
    if (previousPhaseRef.current === "reading" && phase === "spread") uiSfx.play("complete");
    previousPhaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    const root = sectionRef.current?.closest(".variant-app");
    if (!root) return undefined;
    const update = () => {
      const active = root.dataset.view === "consultation";
      setViewActive(active);
      if (active) setEntryHasEntered(true);
      else setFocusAnimating(false);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-view"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // The view is mounted (hidden) from boot; only ask once it is opened.
    if (!viewActive || phase !== "question") return undefined;
    const controller = new AbortController();
    setDailyQuota((current) => ({ ...current, status: "loading" }));
    // Timed out and retried for the same reason as the Today composer: a
    // request iOS froze in the background would otherwise never settle and
    // leave the view on "Reading today's sky…".
    requestWithRetry(async ({ signal }) => {
      const response = await fetch(THREE_CARD_QUESTION_QUOTA_PATH, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || `Question quota failed (${response.status}).`);
      const quota = normalizeDailyQuota(payload);
      if (!quota) throw new Error("The question quota response is invalid.");
      return quota;
    }, { attempts: 3, attemptTimeoutMs: 6_000, retryDelayMs: 600, signal: controller.signal })
      .then((quota) => {
        if (!controller.signal.aborted) setDailyQuota(quota);
      })
      .catch((error) => {
        if (error?.name === "AbortError" || controller.signal.aborted) return;
        console.error("[Living Arcana] Unable to read the daily Three Cards question quota:", error?.message || error);
        setDailyQuota((current) => ({ ...current, status: "unavailable" }));
      });
    return () => controller.abort();
  }, [phase, quotaRefreshKey, viewActive]);

  useEffect(() => {
    if (!["spread", "consultation"].includes(phase) || submitting || recording) return undefined;
    if (spread.some((entry) => !answers[entry.card.id]?.trim())) return undefined;
    // `draft` changes on every keystroke and each write serialises the whole
    // session (answers + threads), so writes are debounced. Leaving the page
    // flushes the pending one, so a reload still restores the latest draft.
    const write = () => writeThreeCardSession({
      phase,
      question,
      consultationId,
      spread: spread.map((entry) => ({ cardId: entry.card.id, positionId: entry.position.id })),
      answers,
      selectedId,
      remaining,
      threads,
      draft,
    });
    const flushWhenHidden = () => { if (document.hidden) write(); };
    const timer = window.setTimeout(write, 300);
    window.addEventListener("pagehide", write);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", write);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [answers, consultationId, draft, phase, question, recording, remaining, selectedId, spread, submitting, threads]);

  useEffect(() => {
    if (!viewActive || phase !== "question" || !prewarmHostRef.current || !spread.length || !spatius) return;
    const key = spread.map((entry) => entry.card.id).join("|");
    if (prewarmKeyRef.current === key) return;
    prewarmKeyRef.current = key;

    if (isExtremeWeakNetwork()) {
      setAvatarFallback(true);
      return;
    }

    let cancelled = false;
    const payload = cardAvatarPayload(spread[0]);
    Promise.resolve(spatius.mount({ readingTarget: prewarmHostRef.current }))
      .then(() => spatius.prepare(payload))
      .then(() => {
        if (cancelled) return;
        setAvatarFallback(false);
      })
      .catch(() => {
        if (!cancelled) setAvatarFallback(true);
      });
    return () => { cancelled = true; };
  }, [cardAvatarPayload, phase, spatius, spread, viewActive]);

  useLayoutEffect(() => {
    if (viewActive || !spatius) return;
    const run = ++avatarSwitchRun.current;
    spatius.interruptSpeech?.();
    setAvatarReady(false);
    const root = sectionRef.current?.closest(".variant-app");
    const todayHost = root?.querySelector('.reading-view [data-spatius-host="reading"]');
    if (!todayHost || !todayCard) return;

    // The adapter owns one movable AvatarKit stage. Returning from Three
    // Cards must restore both its host and its character; moving only the
    // stage leaves the last selected Three Cards avatar inside Today's card.
    // Keep Today's motion video in front until the correct avatar has
    // rendered so the outgoing character never flashes during navigation.
    if (root.dataset.view === "reading") root.dataset.readingMedia = "video";
    const payload = cardAvatarPayload({ card: todayCard });
    Promise.resolve(spatius.mount({ readingTarget: todayHost }))
      .then(() => {
        if (avatarSwitchRun.current !== run) return false;
        return spatius.setAvatar(payload);
      })
      .then((restored) => {
        if (restored === false || avatarSwitchRun.current !== run) return;
        if (root.dataset.view === "reading") root.dataset.readingMedia = "live";
      })
      .catch(() => {
        if (avatarSwitchRun.current !== run) return;
        if (root.dataset.view === "reading") root.dataset.readingMedia = "video";
      });

    return () => { avatarSwitchRun.current += 1; };
  }, [cardAvatarPayload, spatius, todayCard, viewActive]);

  const reset = useCallback(() => {
    uiSfx.activate("retry");
    sessionRun.current += 1;
    clearThreeCardSession();
    abortRequests();
    stopRecording();
    setPhase("question");
    setConsultationId(createConsultationId());
    setReadingIndex(0);
    setReadingStage("summon");
    setDiscovered(0);
    setSelectedId("");
    setHighlightedId("");
    setRemaining(3);
    setDraft("");
    setDailyQuota((current) => ({ ...current, status: "loading" }));
    setStarting(false);
    setSubmitting(false);
    setRecording(false);
    setComposerReady(false);
    setStatus("Ready");
    setFocusAnimating(false);
    setAvatarReady(false);
    setAvatarFallback(false);
    const nextSpread = drawThreeCards();
    setSpread(nextSpread);
    setAnswers(Object.fromEntries(nextSpread.map((entry) => [entry.card.id, ""])));
    setRevealedAnswers(Object.fromEntries(nextSpread.map((entry) => [entry.card.id, ""])));
    setAnswerReady(Object.fromEntries(nextSpread.map((entry) => [entry.card.id, false])));
    setThreads(Object.fromEntries(nextSpread.map((entry) => [entry.card.id, []])));
    prewarmKeyRef.current = "";
    readingSpeechKey.current = "";
    spatius?.interruptSpeech?.();
  }, [abortRequests, spatius, stopRecording]);

  const requestAnswer = useCallback(async (entry, options) => {
    const controller = new AbortController();
    controllers.current.add(controller);
    const { retryDelayMs, ...requestOptions } = options;
    try {
      try {
        return await requestWithRetry(
          ({ signal }) => askCard({ ...requestOptions, entry, signal }),
          {
            attempts: LIVE_ANSWER_ATTEMPTS,
            attemptTimeoutMs: LIVE_ANSWER_TIMEOUT_MS,
            retryDelayMs,
            maxRetryDelayMs: 12_000,
            signal: controller.signal,
            onRetry: ({ attempt, error, nextDelayMs }) => {
              console.warn(
                `[Living Arcana] Three-card live answer retry ${attempt} failed (${entry.card.id}, ${entry.position.id}); retrying in ${nextDelayMs}ms:`,
                error?.message || error,
              );
            },
          },
        );
      } catch (error) {
        if (controller.signal.aborted || error?.name === "AbortError") throw error;
        console.warn(
          `[Living Arcana] Using a grounded local answer after the live reading failed (${entry.card.id}, ${entry.position.id}):`,
          error?.message || error,
        );
        return error?.fallbackAnswer || fallbackTarotAnswer(entry.card, requestOptions.originalQuestion);
      }
    } finally {
      controllers.current.delete(controller);
    }
  }, []);

  const startReading = async (event) => {
    event.preventDefault();
    const cleanQuestion = question.trim();
    if (!cleanQuestion || starting || dailyQuota.status !== "ready") return;
    uiSfx.prepareCardFlip();
    uiSfx.prepareStarSounds();
    uiSfx.activate("start");
    const nextSpread = spread;
    setStarting(true);
    if (!isExtremeWeakNetwork()) {
      // Preserve the submit gesture's audio unlock while the server atomically
      // reserves this question's single daily quota slot.
      void spatius?.unlock?.(cardAvatarPayload(nextSpread[0])).catch(() => {});
    }

    try {
      const response = await fetchWithTimeout(THREE_CARD_QUESTION_QUOTA_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ consultationId }),
      });
      const payload = await response.json().catch(() => null);
      const quota = normalizeDailyQuota(payload);
      if (response.status === 429 && quota) {
        setDailyQuota(quota);
        uiSfx.play("error");
        return;
      }
      if (!response.ok || payload?.allowed !== true || !quota) {
        throw new Error(payload?.error || `Question quota reservation failed (${response.status}).`);
      }
      setDailyQuota(quota);
    } catch (error) {
      console.error("[Living Arcana] Unable to reserve a daily Three Cards question:", error?.message || error);
      // Keep the same consultation ID retryable. If the server reserved the
      // slot but its response was lost, the next submission is idempotent and
      // must still be able to enter the already-counted reading.
      setDailyQuota((current) => ({ ...current, status: current.remaining > 0 ? "ready" : "exhausted" }));
      uiSfx.play("error");
      return;
    } finally {
      setStarting(false);
    }

    const run = ++sessionRun.current;
    clearThreeCardSession();
    abortRequests();
    readingSpeechKey.current = "";
    setQuestion(cleanQuestion);
    setAnswers(Object.fromEntries(nextSpread.map((entry) => [entry.card.id, ""])));
    setRevealedAnswers(Object.fromEntries(nextSpread.map((entry) => [entry.card.id, ""])));
    setAnswerReady(Object.fromEntries(nextSpread.map((entry) => [entry.card.id, false])));
    setThreads(Object.fromEntries(nextSpread.map((entry) => [entry.card.id, []])));
    setReadingIndex(0);
    setReadingStage("summon");
    setDiscovered(0);
    setSelectedId("");
    setRemaining(3);
    setPhase("reading");
    nextSpread.forEach((entry, index) => {
      requestAnswer(entry, { consultationId, originalQuestion: cleanQuestion, retryDelayMs: 420 + index * 180 }).then((answer) => {
        if (sessionRun.current !== run) return;
        setAnswers((current) => ({ ...current, [entry.card.id]: answer }));
        if (sessionRun.current !== run) return;
        setAnswerReady((current) => ({ ...current, [entry.card.id]: true }));
      }).catch((error) => {
        if (error?.name !== "AbortError") {
          console.error(`[Living Arcana] Three-card retry loop stopped unexpectedly (${entry.card.id}):`, error);
        }
      });
    });
  };

  useLayoutEffect(() => {
    if (!viewActive || !spatius || !avatarHostRef.current) return undefined;
    const entry = phase === "reading" ? spread[readingIndex] : phase === "consultation" ? selected : null;
    if (!entry) return undefined;

    const run = ++avatarSwitchRun.current;
    if (isExtremeWeakNetwork()) {
      setAvatarReady(false);
      setAvatarFallback(true);
      return undefined;
    }

    setAvatarReady(false);
    setAvatarFallback(false);
    const payload = cardAvatarPayload(entry);
    Promise.resolve(spatius.mount({ readingTarget: avatarHostRef.current }))
      .then(() => {
        if (avatarSwitchRun.current !== run) return false;
        return spatius.setAvatar(payload);
      })
      .then(() => {
        if (avatarSwitchRun.current !== run) return false;
        setAvatarReady(true);
        // Connection warm-up is intentionally fire-and-forget. Asset/render
        // readiness and speech-service readiness are separate: while the
        // connection catches up we keep the first digital-human frame visible.
        void spatius.startDuplex(payload).catch(() => {});
        return true;
      })
      .catch(() => {
        if (avatarSwitchRun.current !== run) return;
        setAvatarReady(false);
        setAvatarFallback(true);
      });

    return () => { avatarSwitchRun.current += 1; };
  }, [cardAvatarPayload, phase, readingIndex, selected, spatius, spread, viewActive]);

  useEffect(() => {
    if (!viewActive || phase !== "reading") return undefined;
    let cancelled = false;
    let timer = 0;
    let clone = null;
    let animation = null;
    const advanceCard = () => {
      if (cancelled) return;
      const nextDiscovered = readingIndex + 1;
      setDiscovered(nextDiscovered);
      if (readingIndex < spread.length - 1) {
        setReadingIndex((index) => index + 1);
        setReadingStage("summon");
      } else {
        setPhase("spread");
      }
    };

    if (readingStage === "flip") {
      uiSfx.playCardFlip();
      recordCardCollected(spread[readingIndex].card.id);
    }

    if (readingStage === "settle") {
      const source = cardRef.current;
      const target = railSlotRefs.current[readingIndex];
      const flightLayer = sectionRef.current;
      const from = source?.getBoundingClientRect();
      const to = target?.getBoundingClientRect();
      if (reducedMotion || !flightLayer || !from?.width || !to?.width) {
        advanceCard();
        return undefined;
      }
      clone = document.createElement("div");
      clone.className = "three-card-flight";
      clone.style.cssText = `left:${from.left}px;top:${from.top}px;width:${from.width}px;height:${from.height}px;`;
      const sourceRadius = window.getComputedStyle(source).borderRadius;
      if (sourceRadius && sourceRadius !== "0px") clone.style.setProperty("--three-card-flight-radius", sourceRadius);
      const image = document.createElement("img");
      image.src = spread[readingIndex].card.composition.libraryArtworkUrl;
      image.alt = "";
      image.width = 1000;
      image.height = 1600;
      clone.append(image);
      flightLayer.append(clone);
      source.style.visibility = "hidden";
      const deltaX = to.left - from.left;
      const deltaY = to.top - from.top;
      const targetScale = to.width / from.width;
      const midpointScale = 1 + (targetScale - 1) * 0.58;
      const lift = Math.min(72, Math.max(40, from.height * 0.12));
      animation = clone.animate([
        { transform: "translate3d(0,0,0) scale(1)" },
        {
          offset: 0.56,
          transform: `translate3d(${deltaX * 0.56}px,${deltaY * 0.46 - lift}px,0) scale(${midpointScale})`,
        },
        { transform: `translate3d(${deltaX}px,${deltaY}px,0) scale(${targetScale})` },
      ], { duration: 460, easing: "cubic-bezier(0.645,0.045,0.355,1)", fill: "forwards" });
      animation.finished.then(advanceCard).catch(() => {});
    } else if (readingStage !== "speaking") {
      const next = { summon: "flip", flip: "awaken", awaken: "speaking" }[readingStage];
      const delay = { summon: 760, flip: 660, awaken: 520 }[readingStage];
      timer = window.setTimeout(() => !cancelled && setReadingStage(next), reducedMotion ? 0 : delay);
    }

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      animation?.cancel();
      clone?.remove();
      if (cardRef.current) cardRef.current.style.visibility = "";
    };
  }, [phase, readingIndex, readingStage, reducedMotion, spread, viewActive]);

  const readingEntry = spread[readingIndex];
  const readingAnswerReady = Boolean(readingEntry && answerReady[readingEntry.card.id]);
  const readingAnswer = readingEntry ? (answers[readingEntry.card.id] || "") : "";

  useEffect(() => {
    if (phase !== "reading" || readingStage !== "speaking" || !readingEntry || !readingAnswerReady) return undefined;
    const entry = readingEntry;
    const key = `${sessionRun.current}:${readingIndex}:${entry.card.id}`;
    if (readingSpeechKey.current === key) return undefined;
    readingSpeechKey.current = key;
    let cancelled = false;
    let fallbackTimer = 0;
    let revealTimer = 0;
    const text = readingAnswer;
    const run = sessionRun.current;
    const publishReveal = (visibleText) => {
      if (cancelled || sessionRun.current !== run) return;
      setRevealedAnswers((current) => (
        current[entry.card.id] === visibleText
          ? current
          : { ...current, [entry.card.id]: visibleText }
      ));
    };
    const revealer = reducedMotion ? null : createAnswerRevealer({ onReveal: publishReveal });
    if (revealer) {
      revealer.setText(text);
      revealTimer = window.setInterval(() => {
        if (revealer.tick()) window.clearInterval(revealTimer);
      }, 80);
    } else {
      publishReveal(text);
    }
    const finish = () => {
      if (cancelled) return;
      revealer?.snap();
      window.clearInterval(revealTimer);
      setReadingStage("settle");
    };
    const waitAsFallback = () => {
      const duration = reducedMotion ? 0 : Math.min(6_500, Math.max(2_600, text.length * 42));
      // No playable voice: preserve the same reading cadence without exposing
      // the transport failure. A virtual PCM timeline drives the shared text
      // revealer over the static card artwork.
      if (revealer) {
        revealer.notifyPcm(Math.ceil(duration * PCM_BYTES_PER_MS));
        revealer.markAudioComplete();
      }
      fallbackTimer = window.setTimeout(finish, duration);
    };

    if (avatarFallback || isExtremeWeakNetwork() || !spatius) {
      waitAsFallback();
    } else {
      Promise.resolve(spatius.speak({
        ...cardAvatarPayload(entry),
        text,
        onPcm({ byteLength = 0, last = false } = {}) {
          if (cancelled || !revealer) return;
          revealer.notifyPcm(byteLength);
          if (last) revealer.markAudioComplete();
        },
      }))
        .then(finish)
        .catch(() => {
          if (cancelled) return;
          setAvatarReady(false);
          setAvatarFallback(true);
          waitAsFallback();
        });
    }

    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
      window.clearInterval(revealTimer);
      revealer?.cancel();
    };
  }, [cardAvatarPayload, phase, readingAnswer, readingAnswerReady, readingEntry, readingIndex, readingStage, reducedMotion, spatius]);

  useEffect(() => {
    if (phase !== "spread") {
      setComposerReady(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setComposerReady(true), reducedMotion ? 0 : 650);
    return () => window.clearTimeout(timer);
  }, [phase, reducedMotion]);

  const selectCard = (entry, { animate = true } = {}) => {
    if (phase === "consultation" && selectedId === entry.card.id) return;

    uiSfx.activate("select");
    spatius?.interruptSpeech?.();
    setHighlightedId("");
    setSelectedId(entry.card.id);
    setFocusAnimating(animate && !reducedMotion);
    setPhase("consultation");
  };

  useLayoutEffect(() => {
    if (!viewActive || phase !== "consultation" || !focusAnimating || !selected) return undefined;
    const target = spotlightTargetRef.current;
    if (!target || reducedMotion) {
      setFocusAnimating(false);
      return undefined;
    }
    let cancelled = false;
    const animation = target.animate([
      { opacity: 0, transform: "translate3d(8px,0,0) scale(.97)" },
      { opacity: 1, transform: "translate3d(0,0,0) scale(1)" },
    ], { duration: 220, easing: "cubic-bezier(0.32,0.72,0,1)", fill: "both" });
    animation.finished.then(() => {
      if (cancelled) return;
      animation.cancel();
      setFocusAnimating(false);
    }).catch(() => {});
    return () => {
      cancelled = true;
      animation.cancel();
    };
  }, [focusAnimating, phase, reducedMotion, selected, viewActive]);

  const skipReading = () => {
    uiSfx.activate("forward");
    spatius?.interruptSpeech?.();
    // Skipping reveals every card in the spread at once, so they all count as seen.
    for (const entry of spread) recordCardCollected(entry.card.id);
    setDiscovered(3);
    setPhase("spread");
  };

  const submitFollowup = async (event) => {
    event.preventDefault();
    const clean = draft.trim();
    if (!clean || !selected || !remaining || submitting) return;
    uiSfx.activate("send");
    const finalTurn = remaining === 1;
    const id = window.crypto.randomUUID?.() || `${Date.now()}-${remaining}`;
    const run = sessionRun.current;
    setDraft("");
    setRemaining((value) => value - 1);
    setSubmitting(true);
    setStatus("Considering");
    setThreads((current) => ({
      ...current,
      [selected.card.id]: [...(current[selected.card.id] || []), { id, question: clean, answer: "", pending: true }],
    }));
    const controller = new AbortController();
    controllers.current.add(controller);
    const voiceEnabled = Boolean(spatius && !isExtremeWeakNetwork());
    const payload = cardAvatarPayload(selected);
    let pump = null;
    let revealer = null;
    let revealTimer = 0;
    let turnAborted = false;
    let accumulated = "";
    let spokenUpTo = 0;
    let speechStarted = false;

    const updateThreadAnswer = (nextAnswer) => {
      if (!nextAnswer || sessionRun.current !== run) return;
      setThreads((current) => ({
        ...current,
        [selected.card.id]: (current[selected.card.id] || []).map((message) => (
          message.id === id ? { ...message, answer: nextAnswer, pending: false } : message
        )),
      }));
    };

    if (voiceEnabled) {
      revealer = createAnswerRevealer({ onReveal: updateThreadAnswer });
      revealTimer = window.setInterval(() => {
        if (revealer.tick()) window.clearInterval(revealTimer);
      }, 80);

      // Match Today's consultation path: open the avatar and speech socket in
      // parallel with the LLM stream, queue early PCM, and reveal only the
      // portion of text whose audio has actually reached the digital human.
      let avatarSettled = false;
      let settleRetried = false;
      let avatarUnavailable = false;
      const pcmBacklog = [];
      const feedAvatar = (pcmPayload) => {
        const accepted = spatius.streamPcm?.(pcmPayload) === true;
        if (accepted) {
          revealer.notifyPcm(pcmPayload.chunk?.byteLength || 0);
          if (!speechStarted && pcmPayload.chunk?.byteLength) {
            speechStarted = true;
            setStatus("Speaking");
          }
        }
        return accepted;
      };
      const flushBacklog = () => {
        while (pcmBacklog.length) {
          if (!feedAvatar(pcmBacklog[0])) return false;
          pcmBacklog.shift();
        }
        return true;
      };
      const settleAvatar = () => {
        Promise.resolve(spatius.startDuplex?.(payload)).catch(() => {}).then(() => {
          if (turnAborted) {
            pcmBacklog.length = 0;
            return;
          }
          avatarSettled = true;
          if (!flushBacklog()) recoverAvatar();
        });
      };
      const recoverAvatar = () => {
        avatarSettled = false;
        if (settleRetried) {
          avatarUnavailable = true;
          pcmBacklog.length = 0;
          revealer.snap();
          setAvatarReady(false);
          setAvatarFallback(true);
          return;
        }
        settleRetried = true;
        settleAvatar();
      };
      settleAvatar();

      pump = createSentenceSpeechPump({
        spatius: {
          streamPcm(pcmPayload) {
            if (avatarUnavailable) return true;
            if (!avatarSettled) {
              pcmBacklog.push(pcmPayload);
              return true;
            }
            if (!feedAvatar(pcmPayload)) {
              pcmBacklog.push(pcmPayload);
              recoverAvatar();
            }
            return true;
          },
        },
        cardId: selected.card.id,
        voiceId: payload.voiceId,
        voiceSettings: payload.voiceSettings,
      });
    }

    const activeRun = {
      abort() {
        turnAborted = true;
        controller.abort();
        pump?.abort();
        revealer?.cancel();
        window.clearInterval(revealTimer);
      },
    };
    followupRunRef.current = activeRun;

    const acceptStreamText = (nextText) => {
      if (!nextText || turnAborted || sessionRun.current !== run) return;
      accumulated = nextText;
      if (!voiceEnabled) {
        setStatus("Answering");
        updateThreadAnswer(nextText);
        return;
      }
      revealer.setText(nextText);
      let cut;
      while ((cut = findSentenceEnd(nextText, spokenUpTo, spokenUpTo === 0)) > 0) {
        pump.enqueue(nextText.slice(spokenUpTo, cut));
        spokenUpTo = cut;
      }
    };

    try {
      const requestLiveStream = async ({ signal }) => {
        const response = await fetch("/api/arcana/ask-stream", {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
          body: JSON.stringify({
            cardId: selected.card.id,
            question: clean,
            readingContext: makeReadingContext({ originalQuestion: question, entry: selected, consultationId, followup: true }),
            voice: false,
          }),
          signal,
        });
        if (!response.ok) throw new Error(`Reading stream failed (${response.status}).`);
        const contentType = response.headers.get("Content-Type") || "";
        if (contentType.includes("application/json")) {
          const json = await response.json();
          const answer = typeof json?.answer === "string" ? json.answer.trim() : "";
          if (!isLiveAnswerPayload(json) || !answer) {
            const error = new Error(json?.source === "curated"
              ? "The live follow-up service returned curated fallback content."
              : "The live follow-up service returned an invalid response.");
            error.fallbackAnswer = answer;
            throw error;
          }
          acceptStreamText(answer);
          return answer;
        }

        try {
          const answer = await readArcanaAnswerResponse(response, { onText: acceptStreamText });
          if (!answer.trim()) throw new Error("The live follow-up stream returned no text.");
          return answer.trim();
        } catch (error) {
          // A real partial answer is preferable to discarding already spoken
          // text. Only an empty/curated response enters the retry loop.
          if (accumulated.trim()) return accumulated.trim();
          throw error;
        }
      };

      try {
        accumulated = await requestWithRetry(requestLiveStream, {
          attempts: LIVE_ANSWER_ATTEMPTS,
          attemptTimeoutMs: LIVE_ANSWER_TIMEOUT_MS,
          retryDelayMs: 720,
          maxRetryDelayMs: 12_000,
          signal: controller.signal,
          onRetry: ({ attempt, error, nextDelayMs }) => {
            setStatus("Considering");
            console.warn(
              `[Living Arcana] Three-card follow-up retry ${attempt} failed (${selected.card.id}); retrying in ${nextDelayMs}ms:`,
              error?.message || error,
            );
          },
        });
      } catch (error) {
        if (!error?.fallbackAnswer) throw error;
        accumulated = error.fallbackAnswer;
        acceptStreamText(accumulated);
      }

      if (voiceEnabled) {
        const remainder = accumulated.slice(spokenUpTo).trim();
        if (remainder) pump.enqueue(remainder);
        pump.finish();
        const drained = await waitForDrain(pump.done, SPEECH_DRAIN_TIMEOUT_MS);
        if (!drained) pump.abort();
        revealer.markAudioComplete();
        if (!speechStarted) revealer.snap();
      }

      if (sessionRun.current !== run || turnAborted) return;
      setSubmitting(false);
      setStatus(finalTurn ? "Complete" : "Ready");
      uiSfx.stopLoop("three-card-reading");
      uiSfx.play(finalTurn ? "complete" : "receive");
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error("[Living Arcana] three-card streamed turn failed:", error);
        pump?.abort();
        revealer?.cancel();
        window.clearInterval(revealTimer);
        if (accumulated) {
          updateThreadAnswer(accumulated);
          setSubmitting(false);
          setStatus(finalTurn ? "Complete" : "Ready");
        } else {
          setThreads((current) => ({
            ...current,
            [selected.card.id]: (current[selected.card.id] || []).filter((message) => message.id !== id),
          }));
          setDraft(clean);
          setRemaining((value) => Math.min(3, value + 1));
          setSubmitting(false);
          setStatus("Try again");
          uiSfx.play("error");
        }
        uiSfx.stopLoop("three-card-reading");
      }
    } finally {
      controllers.current.delete(controller);
      if (followupRunRef.current === activeRun) followupRunRef.current = null;
    }
  };

  const selectPrompt = (entry) => {
    uiSfx.activate("select");
    spatius?.interruptSpeech?.();
    setSelectedId(entry.card.id);
    setHighlightedId("");
    setDraft(entry.card.question);
    setStatus("Ready");
    setPhase("consultation");
  };

  const handleRecording = async () => {
    if (recordingRef.current) {
      uiSfx.activate("stop");
      stopRecording();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setStatus("Voice unavailable · Type instead");
      uiSfx.activate("blocked");
      return;
    }
    uiSfx.activate("start");
    const request = ++recordRequestRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (request !== recordRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      const chunks = [];
      recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
      recorder.addEventListener("stop", async () => {
        stream.getTracks().forEach((track) => track.stop());
        recordingRef.current = null;
        setRecording(false);
        setStatus("Transcribing");
        try {
          const text = await runUISFXTask({
            key: "three-card-transcription",
            successCue: "success",
            task: async () => {
              const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
              const response = await fetchWithTimeout("/api/arcana/transcribe", { method: "POST", headers: { "Content-Type": blob.type }, body: blob }, TRANSCRIBE_TIMEOUT_MS);
              const payload = await response.json().catch(() => null);
              if (!response.ok || !payload?.text) throw new Error("Transcription failed.");
              return String(payload.text).trim().slice(0, FOLLOWUP_LIMIT);
            },
          });
          setDraft(text);
          setStatus("Ready to send");
        } catch {
          setStatus("Voice unavailable · Type instead");
        }
      }, { once: true });
      recordingRef.current = { recorder, stream };
      recorder.start();
      setRecording(true);
      setStatus("Listening · Tap again to finish");
      window.clearTimeout(recordLimitTimer.current);
      recordLimitTimer.current = window.setTimeout(() => {
        if (recordingRef.current?.recorder === recorder && recorder.state === "recording") recorder.stop();
      }, 30000);
    } catch {
      setStatus("Microphone unavailable");
      uiSfx.play("error");
    }
  };

  return (
    <section
      ref={sectionRef}
      className="scene consultation-view three-card-reading"
      data-three-card-phase={phase}
      aria-label="Three-card reading"
      style={{ "--three-card-active-art": `url(${activeEntry.card.composition.libraryArtworkUrl})` }}
    >
      <div className="three-card-backdrop" aria-hidden="true" />
      <span ref={prewarmHostRef} className="three-card-avatar-prewarm" aria-hidden="true" />
      {phase === "question" ? (
        <Entry
          active={entryHasEntered}
          question={question}
          setQuestion={setQuestion}
          onSubmit={startReading}
          quota={dailyQuota}
          starting={starting}
          onRetryQuota={() => setQuotaRefreshKey((value) => value + 1)}
        />
      ) : null}

      {phase !== "question" ? (
        <aside className="three-card-question">
          <p>Your question</p>
          <h1 title={question}>{question}</h1>
        </aside>
      ) : null}

      {phase === "reading" ? (
        <ReadingSequence
          key={`${spread[readingIndex].position.id}-${spread[readingIndex].card.id}`}
          entry={spread[readingIndex]}
          stage={readingStage}
          answer={revealedAnswers[spread[readingIndex].card.id]}
          answerReady={Boolean(revealedAnswers[spread[readingIndex].card.id])}
          cardRef={cardRef}
          avatarHostRef={avatarHostRef}
          avatarReady={avatarReady}
          avatarFallback={avatarFallback}
          active={viewActive}
          reducedMotion={reducedMotion}
        />
      ) : null}

      {phase === "spread" ? (
        <SpreadSummary spread={spread} answers={answers} answerReady={answerReady} highlightedId={highlightedId} onHover={setHighlightedId} onSelect={selectCard} />
      ) : null}

      {phase === "consultation" && selected ? (
        <ConsultationStage
          entry={selected}
          answer={answers[selected.card.id]}
          answerReady={Boolean(answerReady[selected.card.id])}
          messages={threads[selected.card.id] || []}
          targetRef={spotlightTargetRef}
          avatarHostRef={avatarHostRef}
          avatarReady={avatarReady}
          avatarFallback={avatarFallback}
          active={viewActive}
          reducedMotion={reducedMotion}
        />
      ) : null}

      {phase !== "question" ? (
        <SpreadRail
          spread={spread}
          discovered={discovered}
          selectedId={selectedId}
          disabled={phase === "reading" || submitting}
          slotRefs={railSlotRefs}
          highlightedId={highlightedId}
          onHover={setHighlightedId}
          onSelect={selectCard}
        />
      ) : null}

      {(phase === "reading" || (phase === "spread" && !composerReady)) ? (
        <DrawProgressDock
          filled={discovered}
          onSkip={phase === "spread" ? () => setComposerReady(true) : skipReading}
        />
      ) : null}

      {(phase === "consultation" || (phase === "spread" && composerReady)) ? (
        <FollowupComposer
          spread={spread}
          selected={selected}
          remaining={remaining}
          draft={draft}
          setDraft={setDraft}
          submitting={submitting}
          recording={recording}
          status={status}
          onSubmit={submitFollowup}
          onSelectPrompt={selectPrompt}
          onRecord={handleRecording}
          onEnd={reset}
          continuing
        />
      ) : null}
    </section>
  );
}
