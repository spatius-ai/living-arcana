import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Liquid } from "liquid-gooey";
import { fallbackTarotAnswer } from "../data/tarot.js";
import { findSentenceEnd, readArcanaAnswerResponse } from "../duplex/arcanaAnswerStream.js";
import { ArcanaDuplexUnavailableError, createArcanaDuplexClient, isDuplexSupported } from "../duplex/createArcanaDuplexClient.js";
import { createAnswerRevealer } from "../duplex/answerRevealer.js";
import { createSentenceSpeechPump } from "../duplex/sentenceSpeechPump.js";
import { backgroundMusic, BACKGROUND_MUSIC_RECORDING_DUCK } from "../audio/backgroundMusic.js";
import { uiSfx } from "../audio/uiSfx.js";
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
import "./DuplexComposer.css";
import { fetchWithTimeout } from "../reading/fetchWithTimeout.js";
import { requestWithRetry } from "../reading/requestWithRetry.js";

const loadCosmicMicOrb = () => import("./CosmicMicOrb.jsx");
const CosmicMicOrb = lazy(loadCosmicMicOrb);

const icons = {
  mic: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="8.25" y="3" width="7.5" height="12" rx="3.75" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
    </svg>
  ),
  keyboard: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <rect x="3" y="6" width="18" height="12" rx="3" />
      <path d="M6.5 10h.01M10.15 10h.01M13.85 10h.01M17.5 10h.01M6.5 13.5h.01M17.5 13.5h.01M9.5 14h5" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="m6.5 17.5 11-11M8 6.5h9.5V16" />
    </svg>
  ),
};

const conversationCopy = {
  idle: ["Ready", "Choose voice or text"],
  connecting: ["Connecting", "Opening the live conversation"],
  listening: ["Listening", "Speak anytime · click the mic to end"],
  speaking: ["Speaking", "You can interrupt at any moment"],
  recording: ["Listening", "Speak naturally · click again to ask"],
  transcribing: ["Transcribing", "Turning your words into a question"],
  thinking: ["Considering", "Preparing a response"],
  answered: ["Ready", "Continue by voice or text"],
  error: ["Try again", "The connection paused before answering"],
};

const MAX_RECORDING_MS = 30000;
const MIN_RECORDING_BYTES = 1024;
const QUESTION_MAX_LENGTH = 160;
const DAILY_QUESTION_LIMIT = 3;
const DAILY_QUOTA_PATH = "/api/arcana/daily-card-quota";

class DailyCardLimitError extends Error {
  constructor() {
    super("reached limits");
    this.name = "DailyCardLimitError";
  }
}

function completedTurnHistory(turns) {
  return turns
    .filter((turn) => turn.state === "complete" && turn.question && turn.answer)
    .slice(-(DAILY_QUESTION_LIMIT - 1))
    .flatMap((turn) => [
      { role: "user", content: turn.question },
      { role: "assistant", content: turn.answer },
    ]);
}

function pickRecordingMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
}

function readCardVoice(card) {
  return {
    voiceId: card.tts.voiceId || undefined,
    voiceSettings: {
      stability: card.tts.stability,
      similarityBoost: card.tts.similarityBoost,
      style: card.tts.style,
      speed: card.tts.speed,
    },
  };
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

function useMobileComposer() {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 820px)").matches);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const update = () => setMobile(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return mobile;
}

const LIQUID_COMPOSER_MORPH = Object.freeze({
    shape: true,
    speed: 1,
    bounce: 0,
    contentBlur: 0,
    advanced: {
      evolve: {
        massStiffness: 280,
        massDamping: 30,
        sizeStiffness: 280,
        sizeDamping: 30,
        roundness: 1,
        anticipation: 0,
        travel: 0,
        cornerDuration: 430,
        cornerEase: "cubic-bezier(.22,1,.36,1)",
      },
    },
});

// Both props are booleans and the morph config is a constant, so the gooey
// surface (an SVG-filter layer with its own observers) no longer re-renders —
// and no longer receives a fresh `morph` object — on every revealed chunk of
// the streamed answer.
const AdaptiveLiquidSurface = memo(function AdaptiveLiquidSurface({ open, reducedMotion }) {
  const morph = reducedMotion ? undefined : LIQUID_COMPOSER_MORPH;

  return (
    <Liquid
      className="duplex-liquid"
      blur={6}
      contrast={18}
      fill="var(--duplex-liquid-fill)"
      shadow="0 0 0 1px rgba(255,255,255,.11), inset 0 1px 0 rgba(255,255,255,.17), inset 0 -1px 0 rgba(0,0,0,.2), inset 0 -2px 3px rgba(0,0,0,.1), 0 10px 32px rgba(0,0,0,.12)"
      filterPadding={24}
      aria-hidden="true"
    >
      <Liquid.Item radius={25} observe><i className="duplex-liquid-mic" /></Liquid.Item>
      <Liquid.Item radius={25} observe morph={morph}>
        <i className="duplex-liquid-composer" data-open={open ? "" : undefined} />
      </Liquid.Item>
    </Liquid>
  );
});

export default function DuplexComposer({ variantId, spatius, card }) {
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const keyboardRef = useRef(null);
  const focusTimer = useRef(0);
  const orbFrame = useRef(0);
  const orbTimer = useRef(0);
  const micLiveRef = useRef(false);
  const recorderRef = useRef(null);
  // Bumped by every cancel path: a getUserMedia() still waiting on the
  // permission prompt has no recorder to stop yet, so it compares this after
  // resolving and releases the stream instead of recording into a closed view.
  const recordRequestRef = useRef(0);
  const recordTimer = useRef(0);
  const duplexRef = useRef(null);
  const submittingRef = useRef(false);
  const voiceRunRef = useRef(null);
  const turnsRef = useRef([]);
  const quotaRef = useRef(null);
  const quotaStateRef = useRef("loading");
  const canAskRef = useRef(false);
  const reducedMotion = useReducedMotion();
  const mobileComposer = useMobileComposer();
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [turns, setTurns] = useState([]);
  const [quotaRefreshKey, setQuotaRefreshKey] = useState(0);
  const [quota, setQuota] = useState(null);
  const [quotaState, setQuotaState] = useState("loading");
  const [logOpen, setLogOpen] = useState(false);
  const [conversation, setConversation] = useState("idle");
  const [submitting, setSubmitting] = useState(false);
  const [micLive, setMicLive] = useState(false);
  const [orbMounted, setOrbMounted] = useState(false);
  const [orbPhase, setOrbPhase] = useState("off");
  const fieldId = `duplex-question-${variantId}`;
  const answerId = `duplex-answer-${variantId}`;
  // The visible answer grows chunk by chunk while it streams; as a live region
  // that made screen readers re-announce the partial text on every update.
  // It is announced once instead, when the turn has finished streaming (other
  // messages — errors, limits — are not streamed and announce immediately).
  const answerStreaming = turns[turns.length - 1]?.state === "streaming";
  const announcedAnswer = answerStreaming ? "" : answer;
  const textComposerOpen = open || mobileComposer;
  const limitReached = quotaState === "reached";
  const controlsDisabled = submitting || quotaState !== "ready";

  const commitQuota = useCallback((nextQuota) => {
    const limit = Number.isInteger(nextQuota?.limit) ? nextQuota.limit : DAILY_QUESTION_LIMIT;
    const remaining = Number.isInteger(nextQuota?.remaining)
      ? Math.max(0, Math.min(limit, nextQuota.remaining))
      : 0;
    const normalized = { ...nextQuota, limit, remaining };
    quotaRef.current = normalized;
    setQuota(normalized);
    canAskRef.current = remaining > 0;
    quotaStateRef.current = remaining > 0 ? "ready" : "reached";
    setQuotaState(quotaStateRef.current);
  }, []);

  const setMicrophone = useCallback((next) => {
    window.cancelAnimationFrame(orbFrame.current);
    window.clearTimeout(orbTimer.current);
    micLiveRef.current = next;
    setMicLive(next);

    if (next) {
      setOrbMounted(true);
      setOrbPhase("preparing");
      setConversation("listening");
      spatius?.unlock?.({ cardId: card.id });
      spatius?.setMicrophone?.({ enabled: true, cardId: card.id });
      orbFrame.current = window.requestAnimationFrame(() => setOrbPhase("active"));
      return;
    }

    spatius?.setMicrophone?.({ enabled: false, cardId: card.id });
    setConversation((current) => current === "thinking" ? current : "idle");
    if (!orbMounted) {
      setOrbPhase("off");
      return;
    }
    setOrbPhase("exiting");
    orbTimer.current = window.setTimeout(() => {
      setOrbMounted(false);
      setOrbPhase("off");
    }, reducedMotion ? 0 : 180);
  }, [card.id, orbMounted, reducedMotion, spatius]);

  // The quota gates every control, so one lost request must not strand the
  // composer on "Checking limit": iOS freezes in-flight fetches when the page
  // is backgrounded and may never settle them. Each attempt times out, failed
  // attempts retry with backoff, and `quotaRefreshKey` lets the composer ask
  // again when it is opened or the page returns to the foreground.
  useEffect(() => {
    const controller = new AbortController();
    quotaStateRef.current = "loading";
    canAskRef.current = false;
    setQuotaState("loading");

    requestWithRetry(async ({ signal }) => {
      const response = await fetch(DAILY_QUOTA_PATH, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) throw new Error("Daily quota unavailable");
      return payload;
    }, {
      attempts: 3,
      attemptTimeoutMs: 6_000,
      retryDelayMs: 600,
      signal: controller.signal,
    }).then((payload) => {
      if (controller.signal.aborted) return;
      commitQuota(payload);
      if (payload.remaining <= 0) setAnswer("reached limits");
    }).catch((error) => {
      if (controller.signal.aborted) return;
      console.error("[Living Arcana] daily card quota unavailable:", error);
      quotaStateRef.current = "unavailable";
      canAskRef.current = false;
      setQuotaState("unavailable");
      setAnswer("The daily question limit is temporarily unavailable.");
    });

    return () => controller.abort();
  }, [commitQuota, quotaRefreshKey]);

  useEffect(() => {
    const retryIfUnavailable = () => {
      if (document.hidden || quotaStateRef.current !== "unavailable") return;
      setQuotaRefreshKey((key) => key + 1);
    };
    if (available) retryIfUnavailable();
    document.addEventListener("visibilitychange", retryIfUnavailable);
    window.addEventListener("online", retryIfUnavailable);
    return () => {
      document.removeEventListener("visibilitychange", retryIfUnavailable);
      window.removeEventListener("online", retryIfUnavailable);
    };
  }, [available]);

  const cancelVoiceRun = useCallback(() => {
    voiceRunRef.current?.abort();
    voiceRunRef.current = null;
  }, []);

  const cancelRecording = useCallback(() => {
    cancelVoiceRun();
    duplexRef.current?.stop();
    recordRequestRef.current += 1;
    const active = recorderRef.current;
    if (active) {
      active.mode = "cancelled";
      try { active.recorder.stop(); } catch { recorderRef.current = null; }
    }
    window.clearTimeout(recordTimer.current);
    setMicrophone(false);
  }, [cancelVoiceRun, setMicrophone]);

  useEffect(() => {
    if (!limitReached) return;
    duplexRef.current?.stop();
    recordRequestRef.current += 1;
    const active = recorderRef.current;
    if (active) {
      active.mode = "cancelled";
      try { active.recorder.stop(); } catch { recorderRef.current = null; }
    }
    window.clearTimeout(recordTimer.current);
    setMicrophone(false);
  }, [limitReached, setMicrophone]);

  useEffect(() => {
    const app = rootRef.current?.closest(".variant-app");
    if (!app) return undefined;
    const syncAvailability = () => {
      const qaReady = ["ready", "answered"].includes(app.dataset.qa);
      const visible = app.dataset.view === "reading";
      setAvailable(qaReady && visible);
      if ((!qaReady || !visible) && micLiveRef.current) cancelRecording();
      if (!visible) {
        setOpen(false);
        setLogOpen(false);
      }
    };
    const observer = new MutationObserver(syncAvailability);
    observer.observe(app, { attributes: true, attributeFilter: ["data-qa", "data-view"] });
    syncAvailability();
    return () => observer.disconnect();
  }, [cancelRecording]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden && micLiveRef.current) cancelRecording();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [cancelRecording]);

  useEffect(() => {
    if (available) void loadCosmicMicOrb();
  }, [available]);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    const loopCue = {
      connecting: "connecting",
      recording: "recording",
      transcribing: "processing",
      thinking: "processing",
    }[conversation];
    if (loopCue) uiSfx.startLoop("daily-composer", loopCue);
    else uiSfx.stopLoop("daily-composer");
    return () => uiSfx.stopLoop("daily-composer");
  }, [conversation]);

  useEffect(() => {
    const microphoneActive = ["connecting", "listening", "recording", "transcribing"].includes(conversation);
    backgroundMusic.setDucked("daily-microphone", microphoneActive, BACKGROUND_MUSIC_RECORDING_DUCK);
  }, [conversation]);

  useEffect(() => () => backgroundMusic.setDucked("daily-microphone", false), []);

  useEffect(() => () => {
    window.clearTimeout(focusTimer.current);
    window.clearTimeout(orbTimer.current);
    window.clearTimeout(recordTimer.current);
    window.cancelAnimationFrame(orbFrame.current);
    recordRequestRef.current += 1;
    const active = recorderRef.current;
    if (active) {
      active.mode = "cancelled";
      try { active.recorder.stop(); } catch { recorderRef.current = null; }
    }
    voiceRunRef.current?.abort();
    voiceRunRef.current = null;
    duplexRef.current?.stop();
    if (micLiveRef.current) spatius?.setMicrophone?.({ enabled: false, cardId: card.id });
  }, [card.id, spatius]);

  useEffect(() => {
    voiceRunRef.current?.abort();
    voiceRunRef.current = null;
    duplexRef.current?.stop();
    setQuestion("");
    setAnswer("");
    setTurns([]);
    turnsRef.current = [];
    setLogOpen(false);
    setConversation("idle");
    setOpen(false);
  }, [card.id]);

  const toggleComposer = () => {
    if (quotaStateRef.current !== "ready") return;
    const next = !open;
    uiSfx.activate(next ? "expand" : "collapse");
    setOpen(next);
    window.clearTimeout(focusTimer.current);
    if (!next) {
      if (document.activeElement === inputRef.current) keyboardRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!window.matchMedia("(pointer: coarse)").matches) {
      focusTimer.current = window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), reducedMotion ? 0 : 300);
    }
  };

  /**
   * Streamed turn — used by BOTH voice and text questions: SSE from
   * /api/arcana/ask-stream renders the answer as it generates, and every
   * finished sentence goes straight to the TTS pump so the avatar starts
   * speaking on the first sentence instead of waiting for the full answer.
   * (The old text path waited for the complete answer, then synthesized all
   * of it before the first audible word — its entire latency was serial.)
   * A barge-in or a newer question aborts the whole run (LLM stream +
   * pending TTS).
   */
  const runStreamedTurn = async (rawText, { voice = true } = {}) => {
    const text = String(rawText || "").trim().slice(0, QUESTION_MAX_LENGTH);
    if (!text) return;
    if (!canAskRef.current) {
      setAnswer(quotaStateRef.current === "reached"
        ? "reached limits"
        : "The daily question limit is temporarily unavailable.");
      uiSfx.play("blocked");
      return;
    }
    cancelVoiceRun();

    const turnId = window.crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const history = completedTurnHistory(turnsRef.current);
    const updateTurn = (nextAnswer, pending = true, state = pending ? "streaming" : "complete") => {
      setTurns((current) => {
        const next = current.map((turn) => (
          turn.id === turnId ? { ...turn, answer: nextAnswer, pending, state } : turn
        ));
        turnsRef.current = next;
        return next;
      });
    };
    setTurns((current) => {
      const next = [...current, {
        id: turnId,
        question: text,
        answer: "",
        pending: true,
        state: "streaming",
      }];
      turnsRef.current = next;
      return next;
    });

    const app = rootRef.current?.closest(".variant-app");
    const abortController = new AbortController();
    const voiceCfg = readCardVoice(card);
    // The answer text is NOT painted as the LLM streams it (that finishes a
    // second-plus before the avatar opens its mouth and the silent gap reads
    // as latency): it is revealed subtitle-style, paced to the PCM actually
    // fed to the avatar. Every failure shape snaps the full text out.
    const revealer = createAnswerRevealer({
      onReveal(nextAnswer) {
        setAnswer(nextAnswer);
        updateTurn(nextAnswer, true);
      },
    });
    const revealTimer = window.setInterval(() => {
      if (revealer.tick()) window.clearInterval(revealTimer);
    }, 80);
    // Ensure the avatar is unlocked/connected WITHOUT blocking the LLM
    // stream or the answer text (the old text path awaited this serially
    // before starting TTS). PCM that arrives before the avatar settles is
    // queued and flushed in order.
    //
    // streamPcm returns false when the avatar can't take audio (not yet
    // unlocked, or the connection was released by a tab switch). Those
    // chunks must NOT be dropped — with streaming STT the first answer's
    // PCM can now beat the avatar's arming — so a refused chunk re-queues
    // everything behind one fresh startDuplex and flushes again. The
    // subtitle clock counts only ACCEPTED bytes: audio that never reached
    // the avatar must not advance the visible text (that was the
    // "text moves, avatar silent" bug).
    let turnAborted = false;
    let avatarSettled = false;
    let settleRetried = false;
    const pcmBacklog = [];
    const feedAvatar = (payload) => {
      const accepted = spatius?.streamPcm?.(payload) === true;
      if (accepted) revealer.notifyPcm(payload.chunk?.byteLength || 0);
      return accepted;
    };
    const flushBacklog = () => {
      while (pcmBacklog.length) {
        if (!feedAvatar(pcmBacklog[0])) return false;
        pcmBacklog.shift();
      }
      return true;
    };
    const recoverAvatar = () => {
      avatarSettled = false;
      if (settleRetried) {
        // The avatar is genuinely unavailable this turn: let go of the
        // audio and hand the answer to the reader instead.
        pcmBacklog.length = 0;
        revealer.snap();
        return;
      }
      settleRetried = true;
      settleAvatar();
    };
    const settleAvatar = () => {
      Promise.resolve(spatius?.startDuplex?.({ cardId: card.id })).catch(() => {}).then(() => {
        if (turnAborted) {
          pcmBacklog.length = 0;
          return;
        }
        avatarSettled = true;
        if (!flushBacklog()) recoverAvatar();
      });
    };
    settleAvatar();
    const gatedSpatius = {
      streamPcm(payload) {
        if (!avatarSettled) {
          pcmBacklog.push(payload);
          return true;
        }
        if (!feedAvatar(payload)) {
          pcmBacklog.push(payload);
          recoverAvatar();
        }
        return true;
      },
    };
    const pump = createSentenceSpeechPump({
      spatius: gatedSpatius,
      cardId: card.id,
      voiceId: voiceCfg.voiceId,
      voiceSettings: voiceCfg.voiceSettings,
    });
    const run = {
      abort() {
        turnAborted = true;
        abortController.abort();
        pump.abort();
        // Freeze the transcript where the voice stopped: painting the
        // unspoken remainder right as the user starts a new question reads
        // as the answer "jumping".
        revealer.cancel();
        setTurns((current) => {
          const next = current.map((turn) => (
            turn.id === turnId ? { ...turn, pending: false, state: "interrupted" } : turn
          ));
          turnsRef.current = next;
          return next;
        });
        window.clearInterval(revealTimer);
      },
    };
    voiceRunRef.current = run;
    setAnswer("");
    setConversation("thinking");
    if (app) app.dataset.speaking = "true";
    if (!voice) {
      setSubmitting(true);
      submittingRef.current = true;
    }

    let accumulated = "";
    let spokenUpTo = 0;
    try {
      const response = await fetch("/api/arcana/ask-stream", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
        body: JSON.stringify({
          cardId: card.id,
          question: text,
          voice,
          dailyTurnId: turnId,
          history,
        }),
        signal: abortController.signal,
      });
      if (response.status === 429) {
        const payload = await response.json().catch(() => null);
        commitQuota(payload?.quota || { limit: DAILY_QUESTION_LIMIT, remaining: 0 });
        throw new DailyCardLimitError();
      }
      if (!response.ok) throw new Error(`ask-stream failed (${response.status})`);

      const remainingHeader = response.headers.get("X-Arcana-Daily-Remaining");
      const headerRemaining = remainingHeader === null ? null : Number(remainingHeader);
      const currentQuota = quotaRef.current || { limit: DAILY_QUESTION_LIMIT, remaining: DAILY_QUESTION_LIMIT };
      commitQuota({
        ...currentQuota,
        remaining: Number.isInteger(headerRemaining)
          ? headerRemaining
          : Math.max(0, currentQuota.remaining - 1),
      });

      accumulated = await readArcanaAnswerResponse(response, {
        fallbackAnswer: fallbackTarotAnswer(card, text),
        onText(nextText) {
          accumulated = nextText;
          revealer.setText(nextText);
          let cut;
          while ((cut = findSentenceEnd(nextText, spokenUpTo, spokenUpTo === 0)) > 0) {
            pump.enqueue(nextText.slice(spokenUpTo, cut));
            spokenUpTo = cut;
          }
        },
      });
      const remainder = accumulated.slice(spokenUpTo).trim();
      if (remainder) pump.enqueue(remainder);

      if (app) app.dataset.qa = "answered";
      setConversation(micLiveRef.current ? "listening" : "answered");
      if (!voice) {
        // The full answer text has streamed in; free the input while the
        // remaining sentences are still being voiced.
        setSubmitting(false);
        submittingRef.current = false;
      }
      pump.finish();
      await pump.done;
      // All PCM has been fed; the reveal keeps pacing itself to the end of
      // playback and the interval clears itself once the text is out.
      revealer.markAudioComplete();
      updateTurn(accumulated, false, "complete");
      uiSfx.stopLoop("daily-composer");
      uiSfx.play("receive");
    } catch (error) {
      pump.abort();
      if (error instanceof DailyCardLimitError) {
        revealer.cancel();
        window.clearInterval(revealTimer);
        setTurns((current) => {
          const next = current.filter((turn) => turn.id !== turnId);
          turnsRef.current = next;
          return next;
        });
        setAnswer("reached limits");
        setConversation("idle");
        uiSfx.stopLoop("daily-composer");
        uiSfx.play("blocked");
        return;
      }
      console.error("[Living Arcana] streamed turn failed:", error);
      if (!abortController.signal.aborted) {
        // The error message owns the answer surface now.
        revealer.cancel();
        window.clearInterval(revealTimer);
        const errorAnswer = "The connection paused before answering. Your question is still here—please try once more.";
        setAnswer(errorAnswer);
        updateTurn(errorAnswer, false, "error");
        setConversation("error");
        uiSfx.stopLoop("daily-composer");
        uiSfx.play("error");
      } else {
        revealer.cancel();
        window.clearInterval(revealTimer);
      }
    } finally {
      if (!voice) {
        setSubmitting(false);
        submittingRef.current = false;
      }
      if (voiceRunRef.current === run) voiceRunRef.current = null;
      if (app && !voiceRunRef.current) app.dataset.speaking = "false";
    }
  };

  const askQuestion = async (rawText, { voice = false } = {}) => {
    const text = String(rawText || "").trim().slice(0, QUESTION_MAX_LENGTH);
    if (!text) {
      setAnswer("Begin with one clear question.");
      inputRef.current?.focus();
      return;
    }
    if (!canAskRef.current) {
      setAnswer(quotaStateRef.current === "reached"
        ? "reached limits"
        : "The daily question limit is temporarily unavailable.");
      return;
    }
    await runStreamedTurn(text, { voice });
  };

  const submitQuestion = (event) => {
    event.preventDefault();
    if (!canAskRef.current) return;
    if (question.trim()) uiSfx.activate("send");
    void askQuestion(question);
  };

  const transcribeRecording = async (blob) => {
    setConversation("transcribing");
    try {
      const response = await fetchWithTimeout("/api/arcana/transcribe", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      }, 45_000);
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setAnswer(response.status === 503
          ? "Voice input isn't configured on this deployment yet—type your question instead."
          : "Your voice couldn't be transcribed this time. Try again, or type the question.");
        setConversation("error");
        uiSfx.stopLoop("daily-composer");
        uiSfx.play("error");
        return;
      }
      const text = String(payload?.text || "").trim().slice(0, QUESTION_MAX_LENGTH);
      if (!text) {
        setAnswer("I couldn't catch any words. Try again, a little closer to the microphone.");
        setConversation("idle");
        uiSfx.stopLoop("daily-composer");
        uiSfx.play("blocked");
        return;
      }
      setQuestion(text);
      setOpen(true);
      await askQuestion(text, { voice: true });
    } catch {
      setAnswer("Your voice couldn't reach the server. Check the connection and try once more.");
      setConversation("error");
      uiSfx.stopLoop("daily-composer");
      uiSfx.play("error");
    }
  };

  const finishRecording = () => {
    const active = recorderRef.current;
    window.clearTimeout(recordTimer.current);
    if (!active || active.mode !== "recording") return;
    active.mode = "finishing";
    try { active.recorder.stop(); } catch { recorderRef.current = null; }
    setMicrophone(false);
  };

  const beginRecording = async () => {
    if (recorderRef.current || submitting || !canAskRef.current) return;
    const mimeType = pickRecordingMimeType();
    if (mimeType === null || !navigator.mediaDevices?.getUserMedia) {
      setAnswer("Voice input isn't supported in this browser—type your question instead.");
      setConversation("error");
      uiSfx.play("blocked");
      return;
    }

    const request = ++recordRequestRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (request !== recordRequestRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      const active = { recorder, mode: "recording" };
      recorderRef.current = active;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data?.size) chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        stream.getTracks().forEach((track) => track.stop());
        recorderRef.current = null;
        if (active.mode !== "finishing") return;
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
        if (blob.size < MIN_RECORDING_BYTES) {
          setConversation("idle");
          return;
        }
        void transcribeRecording(blob);
      });
      recorder.start();
      setMicrophone(true);
      setConversation("recording");
      recordTimer.current = window.setTimeout(finishRecording, MAX_RECORDING_MS);
    } catch {
      recorderRef.current = null;
      setAnswer("The microphone couldn't be started. Check browser permissions, or type your question instead.");
      setConversation("error");
      uiSfx.play("error");
    }
  };

  const stopDuplex = () => {
    duplexRef.current?.stop();
  };

  const beginDuplex = async () => {
    if (!canAskRef.current) return;
    if (!duplexRef.current) {
      duplexRef.current = createArcanaDuplexClient({
        onUserUtterance: (text) => {
          // A newer utterance supersedes any in-flight voice turn (the
          // barge-in below has usually cancelled it already).
          setQuestion(String(text).slice(0, QUESTION_MAX_LENGTH));
          void runStreamedTurn(text);
        },
        onPartialTranscript: (text) => {
          // Live transcript from the streaming STT leg while the user is
          // still talking; the committed text lands via onUserUtterance.
          if (text) setQuestion(String(text).slice(0, QUESTION_MAX_LENGTH));
        },
        onBargeIn: () => {
          // Cut avatar audio AND cancel the in-flight LLM stream + queued TTS
          // the moment the user starts talking.
          cancelVoiceRun();
          spatius?.interruptSpeech?.();
        },
        onStateChange: (state) => {
          if (!micLiveRef.current && state !== "idle") return;
          if (state === "connecting") setConversation("connecting");
          if (state === "listening") setConversation("listening");
          if (state === "transcribing") setConversation("transcribing");
        },
        onError: (message) => {
          setAnswer(message);
          setConversation("error");
          uiSfx.stopLoop("daily-composer");
          uiSfx.play("error");
        },
        onEnd: () => {
          setMicrophone(false);
        },
      });
    }

    setMicrophone(true);
    setConversation("connecting");
    try {
      // Warm the avatar path with the same user gesture so the first spoken
      // answer starts without an unlock error.
      await spatius?.startDuplex?.({ cardId: card.id });
      await duplexRef.current.start();
    } catch (error) {
      setMicrophone(false);
      setAnswer(error instanceof ArcanaDuplexUnavailableError
        ? `${error.message} You can still type your question.`
        : "The live conversation could not be started. You can still type, or try the microphone again.");
      setConversation("error");
      uiSfx.stopLoop("daily-composer");
      uiSfx.play("error");
    }
  };

  const handleMicClick = () => {
    if (duplexRef.current?.isRunning()) {
      uiSfx.activate("stop");
      stopDuplex();
      return;
    }
    if (recorderRef.current) {
      uiSfx.activate("stop");
      finishRecording();
      return;
    }
    if (!canAskRef.current) {
      setAnswer(quotaStateRef.current === "reached"
        ? "reached limits"
        : "The daily question limit is temporarily unavailable.");
      uiSfx.play("blocked");
      return;
    }
    uiSfx.activate("start");
    if (isDuplexSupported()) void beginDuplex();
    else void beginRecording();
  };

  const [conversationStatus, conversationGuidance] = conversationCopy[conversation];
  const status = quotaState === "loading"
    ? "Checking limit"
    : quotaState === "unavailable"
      ? "Limit unavailable"
      : limitReached
        ? "reached limits"
        : conversationStatus;
  const guidance = limitReached
    ? "Three questions used today"
    : quotaState === "ready" && conversation === "idle" && quota
      ? `${quota.remaining} of ${quota.limit} questions remaining`
      : conversationGuidance;
  const questionPlaceholder = limitReached ? "reached limits" : card.question;
  const micLabel = limitReached
    ? "Daily question limit reached"
    : micLive
      ? "End the voice conversation"
      : "Start a voice conversation";

  const logId = `today-reading-log-${card.id}`;

  return (
    <ReadingLog open={logOpen} onOpenChange={setLogOpen}>
    {mobileComposer ? (
      <ReadingComposer
        ref={rootRef}
        className="qa-block duplex-composer today-followup"
        data-composer="open"
        data-mic={micLive ? "live" : "off"}
        data-orb={orbPhase}
        data-has-value={Boolean(question.trim())}
        data-limit={quotaState}
        aria-label={`Ask ${card.name}`}
        aria-hidden={available ? "false" : "true"}
        inert={available ? undefined : true}
      >
        <ReadingComposerHeader>
          <ReadingComposerSpeaker>
            <i aria-hidden="true">
              <img src={card.composition.libraryArtworkUrl} alt="" width="1000" height="1600" />
            </i>
            Ask {card.name}
          </ReadingComposerSpeaker>
          <span role="status" aria-live="polite">
            {conversation === "thinking" ? <ShimmerText>Considering…</ShimmerText> : status}
          </span>
          <ReadingComposerActions>
            <ReadingLogTrigger
              className="today-log-trigger three-card-finish-button"
              aria-label={`Open reading log for ${card.name}`}
              aria-controls={logId}
            />
          </ReadingComposerActions>
        </ReadingComposerHeader>
        <ReadingComposerForm data-react-managed="" onSubmit={submitQuestion}>
          <ReadingComposerVoice
            className="today-voice-control"
            aria-label={micLabel}
            aria-pressed={micLive}
            disabled={controlsDisabled || conversation === "transcribing"}
            onClick={handleMicClick}
          >
            {icons.mic}
          </ReadingComposerVoice>
          <ReadingComposerField>
            <span className="sr-only">Your question for {card.name}</span>
            <input
              ref={inputRef}
              id={`${fieldId}-input`}
              className="qa-input"
              name="question"
              autoComplete="off"
              spellCheck="false"
              maxLength={QUESTION_MAX_LENGTH}
              placeholder={questionPlaceholder}
              value={question}
              disabled={controlsDisabled}
              aria-describedby={answer ? answerId : undefined}
              onChange={(event) => {
                setQuestion(event.target.value);
                uiSfx.play("typing", { volume: 0.16, cooldownMs: 0 });
              }}
            />
          </ReadingComposerField>
          <ReadingComposerSend
            aria-label="Ask this question"
            disabled={!question.trim() || controlsDisabled}
          >
            {icons.send}
          </ReadingComposerSend>
        </ReadingComposerForm>
        <p id={answerId} className="qa-answer duplex-answer" aria-live="off">{answer}</p>
      <p className="sr-only" role="status" aria-live="polite">{announcedAnswer}</p>
      </ReadingComposer>
    ) : (
    <section
      ref={rootRef}
      className="qa-block duplex-composer"
      data-composer={textComposerOpen ? "open" : "closed"}
      data-mic={micLive ? "live" : "off"}
      data-orb={orbPhase}
      data-has-value={Boolean(question.trim())}
      data-limit={quotaState}
      aria-label={`Ask ${card.name}`}
      aria-hidden={available ? "false" : "true"}
      inert={available ? undefined : true}
    >
      <div className="duplex-heading">
        <span className="duplex-heading-speaker">
          <i className="duplex-speaker-card" aria-hidden="true">
            <img src={card.composition.libraryArtworkUrl} alt="" width="1000" height="1600" />
          </i>
          <span className="duplex-heading-copy">
            <b>Ask {card.name}</b>
            <small>{guidance}</small>
          </span>
        </span>
        <span className="duplex-heading-actions">
          <em role="status" aria-live="polite">
            {conversation === "thinking" ? <ShimmerText>Considering…</ShimmerText> : status}
          </em>
          <ReadingLogTrigger
            className="today-log-trigger"
            aria-label={`Open reading log for ${card.name}`}
            aria-controls={logId}
          />
        </span>
      </div>
      <form className="qa-form duplex-form" data-react-managed="" onSubmit={submitQuestion}>
        <AdaptiveLiquidSurface open={textComposerOpen} reducedMotion={reducedMotion} />
        <div id={fieldId} className="duplex-field" aria-hidden={textComposerOpen ? "false" : "true"}>
          <label className="sr-only" htmlFor={`${fieldId}-input`}>Your question for {card.name}</label>
          <input
            ref={inputRef}
            id={`${fieldId}-input`}
            className="qa-input duplex-input"
            name="question"
            autoComplete="off"
            spellCheck="false"
            maxLength={QUESTION_MAX_LENGTH}
            placeholder={questionPlaceholder}
            value={question}
            disabled={!textComposerOpen || controlsDisabled}
            tabIndex={textComposerOpen && !controlsDisabled ? 0 : -1}
            aria-describedby={answer ? answerId : undefined}
            onChange={(event) => {
              setQuestion(event.target.value);
              uiSfx.play("typing", { volume: 0.16, cooldownMs: 0 });
            }}
          />
          <button
            className="qa-submit duplex-send"
            type="submit"
            aria-label="Ask this question"
            aria-hidden={textComposerOpen ? "false" : "true"}
            tabIndex={textComposerOpen && !controlsDisabled ? 0 : -1}
            disabled={!question.trim() || controlsDisabled}
          >
            {icons.send}
          </button>
        </div>
        <button
          className="duplex-action duplex-mic"
          type="button"
          aria-label={micLabel}
          aria-pressed={micLive}
          disabled={controlsDisabled || conversation === "transcribing"}
          onClick={handleMicClick}
        >
          <span className="duplex-mic-icon">{icons.mic}</span>
          <span className="cosmic-mic-orb-root" aria-hidden="true">
            {orbMounted && (
              <Suspense fallback={<span className="cosmic-mic-orb-placeholder" />}>
                <CosmicMicOrb reducedMotion={reducedMotion} />
              </Suspense>
            )}
          </span>
        </button>
        <button
          ref={keyboardRef}
          className="duplex-action duplex-keyboard"
          type="button"
          aria-label={open ? "Close text input" : "Type a question"}
          aria-expanded={open}
          aria-controls={fieldId}
          disabled={quotaState !== "ready"}
          onClick={toggleComposer}
        >
          {icons.keyboard}
        </button>
      </form>
      <p id={answerId} className="qa-answer duplex-answer" aria-live="off">{answer}</p>
      <p className="sr-only" role="status" aria-live="polite">{announcedAnswer}</p>
    </section>
    )}
    <ReadingLogContent id={logId} className="today-log-dialog" title={card.name}>
      <ReadingLogReading label={`${card.roman} · Today's themes / ${card.themes.join(" · ")}`}>
        <p>{card.lead}</p>
        <ul>{card.tips.map((tip) => <li key={tip}>{tip}</li>)}</ul>
      </ReadingLogReading>
      {turns.map((turn) => (
        <ReadingLogTurn
          key={turn.id}
          question={turn.question}
          answerLabel={card.name}
          answer={turn.pending ? <ShimmerText>Considering…</ShimmerText> : turn.answer}
          pending={turn.pending}
        />
      ))}
    </ReadingLogContent>
    </ReadingLog>
  );
}
