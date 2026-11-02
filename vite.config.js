import { copyFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { WebSocket as UpstreamWebSocket, WebSocketServer } from "ws";
import { avatarkitVitePlugin } from "@spatius/avatarkit/vite";
import { issueSpatiusSessionToken } from "./server/spatiusSessionToken.js";
import { answerArcanaQuestion, ARCANA_ASK_PATH, ARCANA_ASK_STREAM_PATH, streamArcanaAnswer, validateArcanaQuestion } from "./server/arcanaReading.js";
import { ARCANA_SPEAK_PATH, parseVoiceMap, synthesizeArcanaSpeech, validateArcanaSpeech } from "./server/arcanaSpeech.js";
import { ARCANA_SPEAK_SOCKET_PATH, createSpeechSocketSession } from "./server/arcanaSpeechSocket.js";
import { ARCANA_STT_SOCKET_PATH, createSttSocketSession, DEFAULT_REALTIME_STT_MODEL } from "./server/arcanaSttSocket.js";
import { ARCANA_TRANSCRIBE_PATH, DEFAULT_TRANSCRIBE_MODEL, TRANSCRIBE_AUDIO_LIMIT_BYTES, transcribeArcanaAudio } from "./server/arcanaTranscribe.js";
import {
  consumeDailyCardQuestionQuota,
  consumeThreeCardQuestionQuota,
  createInMemoryThreeCardQuotaBinding,
  DAILY_CARD_DAILY_QUESTION_LIMIT,
  DAILY_CARD_QUESTION_QUOTA_PATH,
  getDailyCardQuestionQuota,
  getThreeCardQuestionQuota,
  isValidQuotaId,
  normalizeThreeCardDailyLimit,
  resolveThreeCardVisitor,
  serializeThreeCardVisitorCookie,
  THREE_CARD_QUESTION_QUOTA_PATH,
  THREE_CARD_QUOTA_TIME_ZONE,
} from "./server/threeCardQuestionQuota.js";

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) reject(new Error("Request body is too large."));
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function spatiusSessionTokenDevPlugin(env) {
  return {
    name: "spatius-session-token-dev",
    configureServer(server) {
      server.middlewares.use("/api/spatius/session-token", async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "application/json; charset=utf-8");

        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end(JSON.stringify({ error: "Method not allowed." }));
          return;
        }

        if (!isSameOrigin(request)) {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: "Cross-origin requests are not allowed." }));
          return;
        }

        try {
          const token = await issueSpatiusSessionToken({
            appId: env.SPATIUS_APP_ID || env.VITE_SPATIUS_APP_ID,
            apiKey: env.SPATIUS_API_KEY,
            region: env.SPATIUS_REGION || env.VITE_SPATIUS_REGION || "ap-northeast",
          });
          response.statusCode = 200;
          response.end(JSON.stringify(token));
        } catch (error) {
          console.error("Unable to issue a Spatius Session Token.", error);
          response.statusCode = 502;
          response.end(JSON.stringify({ error: "The avatar session could not be started." }));
        }
      });
    },
  };
}

function resolveReadingModel(env, request, voice) {
  // Dev-only benchmarking override; production Workers use env config only.
  return request.headers["x-arcana-llm-model"]
    || (voice ? env.OPENROUTER_VOICE_MODEL || env.OPENROUTER_MODEL : env.OPENROUTER_MODEL)
    || undefined;
}

function arcanaReadingDevPlugin(env) {
  const questionQuotaBinding = createInMemoryThreeCardQuotaBinding();
  const quotaOptions = {
    timeZone: env.THREE_CARD_QUOTA_TIME_ZONE || THREE_CARD_QUOTA_TIME_ZONE,
    limit: normalizeThreeCardDailyLimit(env.THREE_CARD_DAILY_QUESTION_LIMIT),
  };
  const dailyQuotaOptions = {
    timeZone: env.DAILY_CARD_QUOTA_TIME_ZONE || env.THREE_CARD_QUOTA_TIME_ZONE || THREE_CARD_QUOTA_TIME_ZONE,
    limit: normalizeThreeCardDailyLimit(env.DAILY_CARD_DAILY_QUESTION_LIMIT || DAILY_CARD_DAILY_QUESTION_LIMIT),
  };

  function setVisitorCookie(request, response, visitor) {
    if (!visitor.isNew) return;
    response.setHeader("Set-Cookie", serializeThreeCardVisitorCookie(visitor.id, {
      secure: Boolean(request.socket?.encrypted),
    }));
  }

  async function enforceQuestionQuota(request, response, validated) {
    if (validated.readingContext && validated.readingContext.mode !== "three-card-initial") return true;
    const visitor = resolveThreeCardVisitor(request.headers);
    if (visitor.isNew) {
      setVisitorCookie(request, response, visitor);
      response.statusCode = 428;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        error: validated.readingContext
          ? "The daily question limit must be initialized before beginning a reading."
          : "The daily card limit must be initialized before asking.",
        code: validated.readingContext ? "question_quota_not_initialized" : "daily_quota_not_initialized",
      }));
      return false;
    }

    if (!validated.readingContext && !validated.dailyTurnId) {
      response.statusCode = 400;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({
        error: "A daily card turn ID is required.",
        code: "daily_turn_id_required",
      }));
      return false;
    }

    const quota = validated.readingContext
      ? await consumeThreeCardQuestionQuota(
          questionQuotaBinding,
          visitor.id,
          validated.readingContext.consultationId,
          quotaOptions,
        )
      : await consumeDailyCardQuestionQuota(
          questionQuotaBinding,
          visitor.id,
          validated.dailyTurnId,
          dailyQuotaOptions,
        );
    if (quota.allowed) {
      if (!validated.readingContext) {
        response.setHeader("X-Arcana-Daily-Limit", String(quota.limit));
        response.setHeader("X-Arcana-Daily-Remaining", String(quota.remaining));
      }
      return true;
    }
    response.statusCode = 429;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      error: validated.readingContext ? "Today’s three questions have already been used." : "reached limits",
      code: validated.readingContext ? "daily_question_limit_reached" : "daily_card_limit_reached",
      quota,
    }));
    return false;
  }

  return {
    name: "arcana-reading-dev",
    configureServer(server) {
      server.middlewares.use(THREE_CARD_QUESTION_QUOTA_PATH, async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        if (!["GET", "POST"].includes(request.method)) {
          response.statusCode = 405;
          response.end(JSON.stringify({ error: "Method not allowed." }));
          return;
        }
        if (!isSameOrigin(request)) {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: "Cross-origin requests are not allowed." }));
          return;
        }

        const visitor = resolveThreeCardVisitor(request.headers);
        setVisitorCookie(request, response, visitor);
        try {
          const quota = request.method === "GET"
            ? await getThreeCardQuestionQuota(questionQuotaBinding, visitor.id, quotaOptions)
            : await (async () => {
              const payload = await readJsonBody(request);
              if (!isValidQuotaId(payload?.consultationId)) {
                response.statusCode = 400;
                return { error: "A valid consultation ID is required." };
              }
              return consumeThreeCardQuestionQuota(questionQuotaBinding, visitor.id, payload.consultationId, quotaOptions);
            })();
          if (request.method === "POST" && quota.allowed === false) response.statusCode = 429;
          else if (!response.statusCode || response.statusCode < 200) response.statusCode = 200;
          response.end(JSON.stringify(quota));
        } catch (error) {
          console.error("Unable to read the Three Cards question quota in development.", error);
          response.statusCode = 503;
          response.end(JSON.stringify({
            error: "The daily question limit is temporarily unavailable.",
            code: "question_quota_unavailable",
          }));
        }
      });

      server.middlewares.use(DAILY_CARD_QUESTION_QUOTA_PATH, async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.end(JSON.stringify({ error: "Method not allowed." }));
          return;
        }
        if (!isSameOrigin(request)) {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: "Cross-origin requests are not allowed." }));
          return;
        }

        const visitor = resolveThreeCardVisitor(request.headers);
        setVisitorCookie(request, response, visitor);
        try {
          const quota = await getDailyCardQuestionQuota(
            questionQuotaBinding,
            visitor.id,
            dailyQuotaOptions,
          );
          response.statusCode = 200;
          response.end(JSON.stringify(quota));
        } catch (error) {
          console.error("Unable to read the daily card question quota in development.", error);
          response.statusCode = 503;
          response.end(JSON.stringify({
            error: "The daily card limit is temporarily unavailable.",
            code: "daily_quota_unavailable",
          }));
        }
      });

      server.middlewares.use(ARCANA_ASK_STREAM_PATH, async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: "Method not allowed." }));
          return;
        }
        if (!isSameOrigin(request)) {
          response.statusCode = 403;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: "Cross-origin requests are not allowed." }));
          return;
        }

        try {
          const validated = validateArcanaQuestion(await readJsonBody(request));
          if (validated.error) {
            response.statusCode = 400;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({ error: validated.error }));
            return;
          }
          if (!await enforceQuestionQuota(request, response, validated)) return;
          const result = await streamArcanaAnswer({
            ...validated,
            apiKey: env.OPENROUTER_API_KEY,
            model: resolveReadingModel(env, request, validated.voice),
          });
          if (result.type === "json") {
            response.statusCode = 200;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify(result.payload));
            return;
          }
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
          response.setHeader("Connection", "keep-alive");
          const reader = result.body.getReader();
          request.on("close", () => { reader.cancel().catch(() => {}); });
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value?.byteLength) response.write(Buffer.from(value));
          }
          response.end();
        } catch {
          if (!response.headersSent) {
            response.statusCode = 400;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({ error: "The question could not be read." }));
          } else {
            response.end();
          }
        }
      });

      server.middlewares.use(ARCANA_ASK_PATH, async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end(JSON.stringify({ error: "Method not allowed." }));
          return;
        }
        if (!isSameOrigin(request)) {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: "Cross-origin requests are not allowed." }));
          return;
        }

        try {
          const validated = validateArcanaQuestion(await readJsonBody(request));
          if (validated.error) {
            response.statusCode = 400;
            response.end(JSON.stringify({ error: validated.error }));
            return;
          }
          if (!await enforceQuestionQuota(request, response, validated)) return;
          const answer = await answerArcanaQuestion({
            ...validated,
            apiKey: env.OPENROUTER_API_KEY,
            model: resolveReadingModel(env, request, validated.voice),
          });
          response.statusCode = 200;
          response.end(JSON.stringify(answer));
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "The question could not be read." }));
        }
      });
    },
  };
}

function arcanaSpeechDevPlugin(env) {
  const voiceMap = parseVoiceMap(env.ELEVENLABS_VOICE_MAP);
  return {
    name: "arcana-speech-dev",
    configureServer(server) {
      server.middlewares.use(ARCANA_SPEAK_PATH, async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end(JSON.stringify({ error: "Method not allowed." }));
          return;
        }
        if (!isSameOrigin(request)) {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: "Cross-origin requests are not allowed." }));
          return;
        }

        try {
          if ((env.TTS_PROVIDER || "elevenlabs") !== "elevenlabs") throw new Error("Unsupported TTS provider.");
          const validated = validateArcanaSpeech(await readJsonBody(request), { voiceMap, allowVoiceOverride: true });
          if (validated.error) {
            response.statusCode = validated.status;
            response.setHeader("Content-Type", "application/json; charset=utf-8");
            response.end(JSON.stringify({ error: validated.error }));
            return;
          }
          const upstream = await synthesizeArcanaSpeech({
            ...validated,
            apiKey: env.ELEVENLABS_API_KEY,
            model: env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
          });
          response.statusCode = 200;
          response.setHeader("Content-Type", "audio/pcm");
          response.setHeader("X-Arcana-Audio-Format", "pcm_s16le_16000_mono");
          const reader = upstream.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value?.byteLength) response.write(Buffer.from(value));
          }
          response.end();
        } catch (error) {
          if (response.headersSent) {
            response.destroy(error);
            return;
          }
          response.statusCode = Number.isInteger(error?.status) ? error.status : 502;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: error?.message || "Real-time speech is unavailable." }));
        }
      });
    },
  };
}

function arcanaSpeechSocketDevPlugin(env) {
  const voiceMap = parseVoiceMap(env.ELEVENLABS_VOICE_MAP);
  return {
    name: "arcana-speech-socket-dev",
    configureServer(server) {
      const sockets = new WebSocketServer({ noServer: true });
      server.httpServer?.on("upgrade", (request, socket, head) => {
        let pathname = "";
        try {
          pathname = new URL(request.url, "http://localhost").pathname;
        } catch {
          return;
        }
        // Anything that is not our endpoint (e.g. Vite's HMR socket) must be
        // left untouched for the other upgrade listeners.
        if (pathname !== ARCANA_SPEAK_SOCKET_PATH) return;
        if (!isSameOrigin(request)) {
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(request, socket, head, (clientSocket) => {
          createSpeechSocketSession({
            clientSocket,
            apiKey: env.ELEVENLABS_API_KEY,
            model: env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
            voiceMap,
            allowVoiceOverride: true,
            ttsProvider: env.TTS_PROVIDER || "elevenlabs",
            connectUpstream: (url) => new Promise((resolve, reject) => {
              const upstream = new WebSocket(url);
              upstream.binaryType = "arraybuffer";
              upstream.addEventListener("open", () => resolve(upstream), { once: true });
              upstream.addEventListener("error", () => reject(new Error("The TTS stream could not be opened.")), { once: true });
            }),
          });
        });
      });
    },
  };
}

function arcanaSttSocketDevPlugin(env) {
  return {
    name: "arcana-stt-socket-dev",
    configureServer(server) {
      const sockets = new WebSocketServer({ noServer: true });
      server.httpServer?.on("upgrade", (request, socket, head) => {
        let pathname = "";
        try {
          pathname = new URL(request.url, "http://localhost").pathname;
        } catch {
          return;
        }
        // Anything that is not our endpoint (Vite HMR, the TTS socket) must
        // be left untouched for the other upgrade listeners.
        if (pathname !== ARCANA_STT_SOCKET_PATH) return;
        if (!isSameOrigin(request)) {
          socket.destroy();
          return;
        }
        sockets.handleUpgrade(request, socket, head, (clientSocket) => {
          createSttSocketSession({
            clientSocket,
            apiKey: env.ELEVENLABS_API_KEY,
            model: env.ELEVENLABS_STT_MODEL || DEFAULT_REALTIME_STT_MODEL,
            // Realtime Scribe authenticates via handshake headers, which the
            // Node built-in WebSocket cannot set — hence the ws client here.
            // Handlers attach at creation: Scribe's first message can share
            // the handshake's I/O tick (see arcanaSttSocket.js).
            connectUpstream: (url, { headers, onMessage, onClose, onError } = {}) => new Promise((resolve, reject) => {
              const upstream = new UpstreamWebSocket(url, { headers });
              upstream.binaryType = "arraybuffer";
              if (onMessage) upstream.addEventListener("message", (event) => onMessage(event.data));
              if (onClose) upstream.addEventListener("close", onClose);
              let opened = false;
              upstream.addEventListener("open", () => {
                opened = true;
                resolve(upstream);
              }, { once: true });
              upstream.addEventListener("error", () => {
                if (opened) onError?.();
                else reject(new Error("The STT stream could not be opened."));
              });
            }),
          });
        });
      });
    },
  };
}

function readRawBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > limit) {
        reject(Object.assign(new Error("The recording is too long."), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function arcanaTranscribeDevPlugin(env) {
  return {
    name: "arcana-transcribe-dev",
    configureServer(server) {
      server.middlewares.use(ARCANA_TRANSCRIBE_PATH, async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end(JSON.stringify({ error: "Method not allowed." }));
          return;
        }
        if (!isSameOrigin(request)) {
          response.statusCode = 403;
          response.end(JSON.stringify({ error: "Cross-origin requests are not allowed." }));
          return;
        }

        try {
          const audio = await readRawBody(request, TRANSCRIBE_AUDIO_LIMIT_BYTES);
          const result = await transcribeArcanaAudio({
            audio,
            contentType: request.headers["content-type"],
            apiKey: env.OPENROUTER_API_KEY,
            // Dev-only escape hatch for benchmarking STT models; the
            // production Worker only ever uses the configured env model.
            model: request.headers["x-arcana-stt-model"]
              || env.OPENROUTER_TRANSCRIBE_MODEL
              || DEFAULT_TRANSCRIBE_MODEL,
          });
          response.statusCode = 200;
          response.end(JSON.stringify(result));
        } catch (error) {
          response.statusCode = Number.isInteger(error?.status) ? error.status : 502;
          response.end(JSON.stringify({ error: error?.message || "Voice transcription is unavailable." }));
        }
      });
    },
  };
}

// avatarkitVitePlugin's closeBundle overwrites dist/_headers with only its WASM
// rule, dropping the cache policy from public/_headers. Runs after it and puts
// the project's file (which already contains that WASM rule) back.
function restoreCloudflareHeadersPlugin() {
  return {
    name: "restore-cloudflare-headers",
    apply: "build",
    enforce: "post",
    closeBundle() {
      copyFileSync("public/_headers", "dist/_headers");
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [
      react(),
      avatarkitVitePlugin(),
      restoreCloudflareHeadersPlugin(),
      spatiusSessionTokenDevPlugin(env),
      arcanaReadingDevPlugin(env),
      arcanaSpeechDevPlugin(env),
      arcanaSpeechSocketDevPlugin(env),
      arcanaSttSocketDevPlugin(env),
      arcanaTranscribeDevPlugin(env),
    ],
  };
});
