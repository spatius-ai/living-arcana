/**
 * Sentence-level speech pump for streamed answers.
 *
 * As the LLM streams, each completed sentence is enqueued here. The primary
 * transport is a same-origin WebSocket (/api/arcana/speak-socket): one voice
 * turn is one ElevenLabs stream-input generation, so sentences are synthesized
 * the moment they arrive, audio comes back in a single ordered PCM stream and
 * cross-sentence prosody is preserved. The socket is dialed at pump creation,
 * so the handshake overlaps transcription/LLM latency.
 *
 * If the socket cannot be opened, errors before any audio arrived, or
 * WebSocket is unavailable, the pump falls back to the previous behavior:
 * one /api/arcana/speak POST per sentence, fetched eagerly but fed to the
 * avatar strictly in order.
 *
 * Either way the PCM goes through spatius.streamPcm with `last: true` sent
 * exactly once at the end, so the mouth doesn't reset between sentences.
 * abort() cancels the whole run — used for barge-in, card changes, unmount.
 * The pump is single-use.
 */

export function createSentenceSpeechPump({
  spatius,
  cardId,
  voiceId,
  voiceSettings,
  speakEndpoint = "/api/arcana/speak",
  socketEndpoint = "/api/arcana/speak-socket",
} = {}) {
  let aborted = false;
  let finished = false;
  let settled = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  const settle = ({ drained }) => {
    if (settled) return;
    settled = true;
    if (drained && !aborted) spatius?.streamPcm?.({ chunk: new ArrayBuffer(0), last: true });
    resolveDone();
  };

  // ---------------------------------------------------------------------
  // HTTP fallback: one POST per sentence, ordered playback.
  // ---------------------------------------------------------------------
  const http = {
    pending: [],
    controllers: [],
    pumping: false,
  };

  const httpSettleIfDrained = () => {
    if (finished && !http.pumping && http.pending.length === 0) settle({ drained: true });
  };

  const httpPumpLoop = async () => {
    if (http.pumping) return;
    http.pumping = true;
    while (http.pending.length && !aborted) {
      const responsePromise = http.pending.shift();
      try {
        const response = await responsePromise;
        if (aborted) break;
        if (!response.ok || !response.body) continue;
        const reader = response.body.getReader();
        while (true) {
          const { done: readDone, value } = await reader.read();
          if (readDone) break;
          if (aborted) {
            await reader.cancel().catch(() => {});
            break;
          }
          if (value?.byteLength) {
            spatius?.streamPcm?.({
              chunk: value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
              last: false,
            });
          }
        }
      } catch {
        // A failed sentence is skipped; the rest of the answer continues.
      }
    }
    http.pumping = false;
    httpSettleIfDrained();
  };

  const httpEnqueue = (sentence) => {
    const controller = new AbortController();
    http.controllers.push(controller);
    http.pending.push(fetch(speakEndpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "audio/pcm", "Content-Type": "application/json" },
      body: JSON.stringify({ cardId, text: sentence, voiceId, voiceSettings }),
      signal: controller.signal,
    }));
    void httpPumpLoop();
  };

  // ---------------------------------------------------------------------
  // WebSocket transport.
  // ---------------------------------------------------------------------
  const sent = [];
  let mode = typeof WebSocket === "function" ? "socket" : "http";
  let socket = null;
  let socketOpen = false;
  let receivedAudio = false;
  const preOpenQueue = [];
  let endQueued = false;

  const fallBackToHttp = () => {
    if (mode !== "socket" || aborted || settled) return;
    mode = "http";
    sent.forEach(httpEnqueue);
    if (finished) httpSettleIfDrained();
  };

  const socketSend = (payload) => {
    try { socket.send(JSON.stringify(payload)); } catch { /* closing */ }
  };

  if (mode === "socket") {
    try {
      const scheme = window.location.protocol === "https:" ? "wss://" : "ws://";
      socket = new WebSocket(`${scheme}${window.location.host}${socketEndpoint}`);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => {
        if (aborted || mode !== "socket") return;
        socketOpen = true;
        socketSend({ type: "init", cardId, voiceId, voiceSettings });
        while (preOpenQueue.length) socketSend({ type: "text", text: preOpenQueue.shift() });
        if (endQueued) socketSend({ type: "end" });
      });
      socket.addEventListener("message", (event) => {
        if (aborted || mode !== "socket") return;
        if (typeof event.data !== "string") {
          if (event.data?.byteLength) {
            receivedAudio = true;
            spatius?.streamPcm?.({ chunk: event.data, last: false });
          }
          return;
        }
        try {
          const payload = JSON.parse(event.data);
          if (payload?.type === "final") settle({ drained: true });
          // An error before any audio still has the full transcript buffered,
          // so the per-sentence fallback can voice the whole answer.
          if (payload?.type === "error" && !receivedAudio) fallBackToHttp();
        } catch { /* ignore malformed control frames */ }
      });
      socket.addEventListener("close", () => {
        if (aborted || settled || mode !== "socket") return;
        if (receivedAudio) settle({ drained: true });
        else fallBackToHttp();
      });
      socket.addEventListener("error", () => {
        if (aborted || settled || mode !== "socket") return;
        if (!receivedAudio) fallBackToHttp();
      });
    } catch {
      socket = null;
      mode = "http";
    }
  }

  return {
    enqueue(text) {
      const sentence = String(text || "").trim();
      if (!sentence || aborted || finished) return;
      sent.push(sentence);
      if (mode === "socket") {
        if (socketOpen) socketSend({ type: "text", text: sentence });
        else preOpenQueue.push(sentence);
        return;
      }
      httpEnqueue(sentence);
    },
    finish() {
      if (finished) return;
      finished = true;
      if (mode === "socket") {
        if (socketOpen) socketSend({ type: "end" });
        else endQueued = true;
        return;
      }
      httpSettleIfDrained();
    },
    abort() {
      if (aborted) return;
      aborted = true;
      finished = true;
      if (socket) {
        try { socket.close(); } catch { /* already closed */ }
      }
      http.controllers.forEach((controller) => controller.abort());
      http.pending.length = 0;
      settle({ drained: false });
    },
    done,
  };
}
