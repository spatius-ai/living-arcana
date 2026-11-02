const MIN_SENTENCE_CHARS = 8;
const SENTENCE_TERMINATORS = /[。！？!?.\n]/;
// The first spoken chunk can end at a clause boundary so the avatar begins
// speaking sooner while the rest of the answer continues to stream.
const CLAUSE_TERMINATORS = /[。！？!?.\n,，、;；:：]/;

export function findSentenceEnd(text, from, aggressive = false) {
  const terminators = aggressive ? CLAUSE_TERMINATORS : SENTENCE_TERMINATORS;
  for (let index = from + MIN_SENTENCE_CHARS; index < text.length; index += 1) {
    if (!terminators.test(text[index])) continue;
    let end = index + 1;
    while (end < text.length && /["'」』”’)]/.test(text[end])) end += 1;
    return end;
  }
  return -1;
}

function readEventDelta(event) {
  let delta = "";
  for (const line of event.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const content = JSON.parse(data).choices?.[0]?.delta?.content;
      if (typeof content === "string") delta += content;
    } catch { /* keep-alive comments and malformed frames are ignored */ }
  }
  return delta;
}

/**
 * Consumes either the JSON fallback or OpenAI-compatible SSE response from
 * /api/arcana/ask-stream. onText receives the complete accumulated answer
 * after every delta so every consultation surface follows one stream parser.
 */
export async function readArcanaAnswerResponse(response, { fallbackAnswer = "", onText } = {}) {
  const publish = (text) => {
    onText?.(text);
    return text;
  };

  if ((response.headers.get("Content-Type") || "").includes("application/json")) {
    const payload = await response.json();
    return publish(String(payload?.answer || fallbackAnswer));
  }

  if (!response.body) return publish(String(fallbackAnswer));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let accumulated = "";

  const consumeEvents = (flush = false) => {
    buffered = buffered.replace(/\r\n/g, "\n");
    const events = buffered.split("\n\n");
    buffered = flush ? "" : events.pop();
    if (flush && events.at(-1) === "") events.pop();
    for (const event of events) {
      const delta = readEventDelta(event);
      if (!delta) continue;
      accumulated += delta;
      publish(accumulated);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    consumeEvents();
  }
  buffered += decoder.decode();
  consumeEvents(true);

  if (!accumulated) accumulated = publish(String(fallbackAnswer));
  return accumulated;
}
