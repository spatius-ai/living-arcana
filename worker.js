import { issueSpatiusSessionToken } from "./server/spatiusSessionToken.js";
import { answerArcanaQuestion, ARCANA_ASK_PATH, ARCANA_ASK_STREAM_PATH, streamArcanaAnswer, validateArcanaQuestion } from "./server/arcanaReading.js";
import { ARCANA_SPEAK_PATH, parseVoiceMap, synthesizeArcanaSpeech, validateArcanaSpeech } from "./server/arcanaSpeech.js";
import { ARCANA_SPEAK_SOCKET_PATH, createSpeechSocketSession } from "./server/arcanaSpeechSocket.js";
import { ARCANA_STT_SOCKET_PATH, createSttSocketSession, DEFAULT_REALTIME_STT_MODEL } from "./server/arcanaSttSocket.js";
import { ARCANA_TRANSCRIBE_PATH, DEFAULT_TRANSCRIBE_MODEL, TRANSCRIBE_AUDIO_LIMIT_BYTES, transcribeArcanaAudio } from "./server/arcanaTranscribe.js";
import {
  consumeDailyCardQuestionQuota,
  consumeThreeCardQuestionQuota,
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
  ThreeCardQuestionQuota,
} from "./server/threeCardQuestionQuota.js";

export { ThreeCardQuestionQuota };

const TOKEN_PATH = "/api/spatius/session-token";

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function isSameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;

  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

function questionQuotaOptions(env) {
  return {
    timeZone: env.THREE_CARD_QUOTA_TIME_ZONE || THREE_CARD_QUOTA_TIME_ZONE,
    limit: normalizeThreeCardDailyLimit(env.THREE_CARD_DAILY_QUESTION_LIMIT),
  };
}

function dailyCardQuotaOptions(env) {
  return {
    timeZone: env.DAILY_CARD_QUOTA_TIME_ZONE || env.THREE_CARD_QUOTA_TIME_ZONE || THREE_CARD_QUOTA_TIME_ZONE,
    limit: normalizeThreeCardDailyLimit(env.DAILY_CARD_DAILY_QUESTION_LIMIT || DAILY_CARD_DAILY_QUESTION_LIMIT),
  };
}

function visitorCookieHeader(request, visitor) {
  if (!visitor.isNew) return {};
  return {
    "Set-Cookie": serializeThreeCardVisitorCookie(visitor.id, {
      secure: new URL(request.url).protocol === "https:",
    }),
  };
}

async function enforceThreeCardQuestionQuota(request, env, validated) {
  if (validated.readingContext?.mode !== "three-card-initial") return null;

  const visitor = resolveThreeCardVisitor(request.headers);
  const headers = visitorCookieHeader(request, visitor);
  if (visitor.isNew) {
    return json({
      error: "The daily question limit must be initialized before beginning a reading.",
      code: "question_quota_not_initialized",
    }, 428, headers);
  }

  try {
    const quota = await consumeThreeCardQuestionQuota(
      env.THREE_CARD_QUESTION_QUOTA,
      visitor.id,
      validated.readingContext.consultationId,
      questionQuotaOptions(env),
    );
    if (!quota.allowed) {
      return json({
        error: "Today’s three questions have already been used.",
        code: "daily_question_limit_reached",
        quota,
      }, 429);
    }
    return null;
  } catch (error) {
    console.error("Unable to enforce the Three Cards question quota.", error);
    return json({
      error: "The daily question limit is temporarily unavailable.",
      code: "question_quota_unavailable",
    }, 503);
  }
}

async function enforceDailyCardQuestionQuota(request, env, validated) {
  if (validated.readingContext) return { response: null, quota: null };
  if (!validated.dailyTurnId) {
    return {
      response: json({
        error: "A daily card turn ID is required.",
        code: "daily_turn_id_required",
      }, 400),
      quota: null,
    };
  }

  const visitor = resolveThreeCardVisitor(request.headers);
  const headers = visitorCookieHeader(request, visitor);
  if (visitor.isNew) {
    return {
      response: json({
        error: "The daily card limit must be initialized before asking.",
        code: "daily_quota_not_initialized",
      }, 428, headers),
      quota: null,
    };
  }

  try {
    const quota = await consumeDailyCardQuestionQuota(
      env.THREE_CARD_QUESTION_QUOTA,
      visitor.id,
      validated.dailyTurnId,
      dailyCardQuotaOptions(env),
    );
    if (!quota.allowed) {
      return {
        response: json({
          error: "reached limits",
          code: "daily_card_limit_reached",
          quota,
        }, 429),
        quota,
      };
    }
    return { response: null, quota };
  } catch (error) {
    console.error("Unable to enforce the daily card question quota.", error);
    return {
      response: json({
        error: "The daily card limit is temporarily unavailable.",
        code: "daily_quota_unavailable",
      }, 503),
      quota: null,
    };
  }
}

function dailyQuotaHeaders(quota) {
  if (!quota) return {};
  return {
    "X-Arcana-Daily-Limit": String(quota.limit),
    "X-Arcana-Daily-Remaining": String(quota.remaining),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === THREE_CARD_QUESTION_QUOTA_PATH) {
      if (!["GET", "POST"].includes(request.method)) return json({ error: "Method not allowed." }, 405);
      if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);

      const visitor = resolveThreeCardVisitor(request.headers);
      const headers = visitorCookieHeader(request, visitor);
      try {
        if (request.method === "GET") {
          const quota = await getThreeCardQuestionQuota(
            env.THREE_CARD_QUESTION_QUOTA,
            visitor.id,
            questionQuotaOptions(env),
          );
          return json(quota, 200, headers);
        }

        const payload = await request.json();
        if (!isValidQuotaId(payload?.consultationId)) {
          return json({ error: "A valid consultation ID is required." }, 400, headers);
        }
        const quota = await consumeThreeCardQuestionQuota(
          env.THREE_CARD_QUESTION_QUOTA,
          visitor.id,
          payload.consultationId,
          questionQuotaOptions(env),
        );
        return json(quota, quota.allowed ? 200 : 429, headers);
      } catch (error) {
        console.error("Unable to read the Three Cards question quota.", error);
        return json({
          error: "The daily question limit is temporarily unavailable.",
          code: "question_quota_unavailable",
        }, 503, headers);
      }
    }

    if (url.pathname === DAILY_CARD_QUESTION_QUOTA_PATH) {
      if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
      if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);

      const visitor = resolveThreeCardVisitor(request.headers);
      const headers = visitorCookieHeader(request, visitor);
      try {
        const quota = await getDailyCardQuestionQuota(
          env.THREE_CARD_QUESTION_QUOTA,
          visitor.id,
          dailyCardQuotaOptions(env),
        );
        return json(quota, 200, headers);
      } catch (error) {
        console.error("Unable to read the daily card question quota.", error);
        return json({
          error: "The daily card limit is temporarily unavailable.",
          code: "daily_quota_unavailable",
        }, 503, headers);
      }
    }

    if (url.pathname === TOKEN_PATH) {
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);

      try {
        const token = await issueSpatiusSessionToken({
          appId: env.SPATIUS_APP_ID,
          apiKey: env.SPATIUS_API_KEY,
          region: env.SPATIUS_REGION || "ap-northeast",
        });
        return json(token);
      } catch (error) {
        console.error("Unable to issue a Spatius Session Token.", error);
        return json({ error: "The avatar session could not be started." }, 502);
      }
    }

    if (url.pathname === ARCANA_ASK_STREAM_PATH) {
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);

      try {
        const validated = validateArcanaQuestion(await request.json());
        if (validated.error) return json({ error: validated.error }, 400);
        const quotaResponse = await enforceThreeCardQuestionQuota(request, env, validated);
        if (quotaResponse) return quotaResponse;
        const dailyQuotaCheck = await enforceDailyCardQuestionQuota(request, env, validated);
        if (dailyQuotaCheck.response) return dailyQuotaCheck.response;
        const result = await streamArcanaAnswer({
          ...validated,
          apiKey: env.OPENROUTER_API_KEY,
          model: (validated.voice ? env.OPENROUTER_VOICE_MODEL || env.OPENROUTER_MODEL : env.OPENROUTER_MODEL) || undefined,
        });
        if (result.type === "json") return json(result.payload, 200, dailyQuotaHeaders(dailyQuotaCheck.quota));
        return new Response(result.body, {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "text/event-stream; charset=utf-8",
            ...dailyQuotaHeaders(dailyQuotaCheck.quota),
          },
        });
      } catch {
        return json({ error: "The question could not be read." }, 400);
      }
    }

    if (url.pathname === ARCANA_ASK_PATH) {
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);

      try {
        const validated = validateArcanaQuestion(await request.json());
        if (validated.error) return json({ error: validated.error }, 400);
        const quotaResponse = await enforceThreeCardQuestionQuota(request, env, validated);
        if (quotaResponse) return quotaResponse;
        const dailyQuotaCheck = await enforceDailyCardQuestionQuota(request, env, validated);
        if (dailyQuotaCheck.response) return dailyQuotaCheck.response;
        const answer = await answerArcanaQuestion({
          ...validated,
          apiKey: env.OPENROUTER_API_KEY,
          model: (validated.voice ? env.OPENROUTER_VOICE_MODEL || env.OPENROUTER_MODEL : env.OPENROUTER_MODEL) || undefined,
        });
        return json(answer, 200, dailyQuotaHeaders(dailyQuotaCheck.quota));
      } catch {
        return json({ error: "The question could not be read." }, 400);
      }
    }

    if (url.pathname === ARCANA_SPEAK_SOCKET_PATH) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "This endpoint only accepts WebSocket connections." }, 426);
      }
      if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      createSpeechSocketSession({
        clientSocket: server,
        apiKey: env.ELEVENLABS_API_KEY,
        model: env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
        voiceMap: parseVoiceMap(env.ELEVENLABS_VOICE_MAP),
        allowVoiceOverride: env.ALLOW_TTS_VOICE_OVERRIDE === "true",
        ttsProvider: env.TTS_PROVIDER || "elevenlabs",
        connectUpstream: async (socketUrl) => {
          // Workers dial outbound WebSockets through fetch + Upgrade.
          const response = await fetch(socketUrl.replace(/^wss:/, "https:"), {
            headers: { Upgrade: "websocket" },
          });
          const upstream = response.webSocket;
          if (!upstream) throw new Error(`TTS socket upgrade failed (${response.status}).`);
          upstream.accept();
          return upstream;
        },
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === ARCANA_STT_SOCKET_PATH) {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "This endpoint only accepts WebSocket connections." }, 426);
      }
      if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      createSttSocketSession({
        clientSocket: server,
        apiKey: env.ELEVENLABS_API_KEY,
        model: env.ELEVENLABS_STT_MODEL || DEFAULT_REALTIME_STT_MODEL,
        connectUpstream: async (socketUrl, { headers, onMessage, onClose, onError } = {}) => {
          // Workers dial outbound WebSockets through fetch + Upgrade; the
          // realtime Scribe key travels in the handshake headers. Handlers
          // attach before returning so the first upstream message (which can
          // arrive immediately after accept) is never dropped.
          const response = await fetch(socketUrl.replace(/^wss:/, "https:"), {
            headers: { Upgrade: "websocket", ...headers },
          });
          const upstream = response.webSocket;
          if (!upstream) throw new Error(`STT socket upgrade failed (${response.status}).`);
          upstream.accept();
          if (onMessage) upstream.addEventListener("message", (event) => onMessage(event.data));
          if (onClose) upstream.addEventListener("close", onClose);
          if (onError) upstream.addEventListener("error", onError);
          return upstream;
        },
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === ARCANA_SPEAK_PATH) {
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);

      try {
        if ((env.TTS_PROVIDER || "elevenlabs") !== "elevenlabs") return json({ error: "Unsupported TTS provider." }, 503);
        const validated = validateArcanaSpeech(await request.json(), {
          voiceMap: parseVoiceMap(env.ELEVENLABS_VOICE_MAP),
          allowVoiceOverride: env.ALLOW_TTS_VOICE_OVERRIDE === "true",
        });
        if (validated.error) return json({ error: validated.error }, validated.status);
        const upstream = await synthesizeArcanaSpeech({
          ...validated,
          apiKey: env.ELEVENLABS_API_KEY,
          model: env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
        });
        return new Response(upstream.body, {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "audio/pcm",
            "X-Arcana-Audio-Format": "pcm_s16le_16000_mono",
          },
        });
      } catch (error) {
        return json({ error: error?.message || "Real-time speech is unavailable." }, Number.isInteger(error?.status) ? error.status : 502);
      }
    }

    if (url.pathname === ARCANA_TRANSCRIBE_PATH) {
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);

      try {
        const declaredLength = Number(request.headers.get("Content-Length"));
        if (Number.isFinite(declaredLength) && declaredLength > TRANSCRIBE_AUDIO_LIMIT_BYTES) {
          return json({ error: "The recording is too long." }, 413);
        }
        const audio = await request.arrayBuffer();
        const result = await transcribeArcanaAudio({
          audio,
          contentType: request.headers.get("Content-Type"),
          apiKey: env.OPENROUTER_API_KEY,
          model: env.OPENROUTER_TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL,
        });
        return json(result);
      } catch (error) {
        return json({ error: error?.message || "Voice transcription is unavailable." }, Number.isInteger(error?.status) ? error.status : 502);
      }
    }

    return env.ASSETS.fetch(request);
  },
};
