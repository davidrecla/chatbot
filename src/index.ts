import { ClaudeApiError, streamClaudeReply, type GatewayRequestOptions } from "./claude";
import { fetchInsightsSummary, runAbTestOnce, runOutageDemo } from "./gateway";
import { buildSystemPrompt } from "./knowledge";
import { ChatSession } from "./session";
import type { ChatMessage, ChatRequestBody, Env, FeedbackRequestBody } from "./types";

export { ChatSession };

const SESSION_COOKIE = "pgc_session";
const MAX_MESSAGE_LENGTH = 2000;
const CAP_REACHED_MESSAGE =
  "This conversation's gotten pretty long! Please refresh the page to start a fresh one, I'll be right here.";

// How long a cached opening-question answer stays valid before Claude gets
// asked again -- long enough to visibly save cost on repeat visitors within
// a session/day, short enough that it won't go stale for long if the
// knowledge base changes.
const FAQ_CACHE_TTL_SECONDS = 60 * 60;

/**
 * Common opening questions ("what's your best seller?", "do you ship
 * nationwide?") asked by different visitors should be genuinely cacheable --
 * same system prompt, same (empty) history, same normalized question means
 * the answer is fine to reuse across people. Only the *first* message of a
 * session qualifies: once there's conversation history, the request is
 * specific to that conversation and shouldn't be cached across sessions.
 */
function openingQuestionCacheOptions(history: ChatMessage[]): Partial<GatewayRequestOptions> {
  if (history.length !== 1) return {};
  const normalized = history[0]!.content
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[?!.]+$/, "");
  if (!normalized) return {};
  return { cacheKey: `opening-question:${normalized}`, cacheTtlSeconds: FAQ_CACHE_TTL_SECONDS };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/chat" && request.method === "POST") {
        return await handleChat(request, env, ctx);
      }
      if (url.pathname === "/api/feedback" && request.method === "POST") {
        return await handleFeedback(request, env);
      }
      if (url.pathname === "/api/demo/resilience" && request.method === "POST") {
        return await handleResilienceDemo(request, env);
      }
      if (url.pathname === "/api/insights/summary" && request.method === "GET") {
        return await handleInsightsSummary(env);
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return jsonResponse(500, { error: "Internal error" });
    }
  },
} satisfies ExportedHandler<Env>;

async function handleChat(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const message = (body.message ?? "").toString().trim();
  if (!message) return jsonResponse(400, { error: "message is required" });
  if (message.length > MAX_MESSAGE_LENGTH) {
    return jsonResponse(400, { error: `message must be under ${MAX_MESSAGE_LENGTH} characters` });
  }

  const { sessionId, setCookie } = getOrCreateSessionId(request);
  const stub = env.CHAT_SESSION.get(env.CHAT_SESSION.idFromName(sessionId));

  const { history, limitReached } = await stub.appendMessage({ role: "user", content: message });

  const { stream: textStream, logId } = limitReached
    ? { stream: staticTextStream(CAP_REACHED_MESSAGE), logId: null }
    : await claudeReplyStream(env, history, stub, sessionId);

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  if (setCookie) headers.set("set-cookie", setCookie);

  const encoder = new TextEncoder();
  const metaFrame = encoder.encode(`event: meta\ndata: ${JSON.stringify({ logId })}\n\n`);
  return new Response(prependBytes(textStream.pipeThrough(sseEncoder()), metaFrame), { headers });
}

/** POST /api/feedback -- attaches a 👍/👎 to a specific Gateway log entry. */
async function handleFeedback(request: Request, env: Env): Promise<Response> {
  let body: FeedbackRequestBody;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }
  if (!body.logId || (body.rating !== 1 && body.rating !== -1)) {
    return jsonResponse(400, { error: "logId and rating (1 or -1) are required" });
  }

  try {
    await env.AI.gateway(env.CF_AI_GATEWAY_ID ?? "pgc-chatbot").patchLog(body.logId, { feedback: body.rating });
  } catch (err) {
    console.error(err);
    return jsonResponse(502, { error: "Could not record feedback" });
  }
  return jsonResponse(200, { ok: true });
}

/**
 * POST /api/demo/resilience -- the "Resilience Lab" (Build-Plan-Chatbot.md
 * checklist items 22-23). Admin/demo-only surface, not part of the everyday
 * chat path. Body: { "mode": "outage" | "ab-test" }.
 */
async function handleResilienceDemo(request: Request, env: Env): Promise<Response> {
  let body: { mode?: string };
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  try {
    const result = body.mode === "ab-test" ? await runAbTestOnce(env) : await runOutageDemo(env);
    return jsonResponse(200, result);
  } catch (err) {
    console.error(err);
    return jsonResponse(502, { error: "Demo call failed" });
  }
}

/** GET /api/insights/summary -- powers the /insights admin panel. */
async function handleInsightsSummary(env: Env): Promise<Response> {
  try {
    const summary = await fetchInsightsSummary(env);
    return jsonResponse(200, summary);
  } catch (err) {
    console.error(err);
    return jsonResponse(502, { error: "Could not load insights" });
  }
}

interface ClaudeReplyResult {
  stream: ReadableStream<string>;
  logId: string | null;
}

/** Streams Claude's reply and, once fully streamed, saves it as the session's assistant turn. */
async function claudeReplyStream(
  env: Env,
  history: ChatMessage[],
  stub: DurableObjectStub<ChatSession>,
  sessionId: string,
): Promise<ClaudeReplyResult> {
  let reply: { stream: ReadableStream<string>; logId: string | null };
  try {
    reply = await streamClaudeReply(env, buildSystemPrompt(), history, {
      metadata: { session_id: sessionId, surface: "public-chat" },
      ...openingQuestionCacheOptions(history),
    });
  } catch (err) {
    console.error(err);
    // Never leak raw provider/Gateway error text to the customer (internal
    // details, sometimes literal JSON). Guardrails/DLP blocking a prompt
    // (HTTP 424) gets a warm, on-brand decline; anything else gets a
    // generic "try again" -- both stay in character, no tech-support tone.
    const blocked = err instanceof ClaudeApiError && err.status === 424;
    const message = blocked
      ? "I can't help with that one. Happy to talk coffee, pricing, or brewing though, what can I get you?"
      : "Sorry, I'm having trouble getting a response right now. Please try again in a moment.";
    return { stream: staticTextStream(message), logId: null };
  }

  let full = "";
  const stream = reply.stream.pipeThrough(
    new TransformStream<string, string>({
      transform(chunk, controller) {
        full += chunk;
        controller.enqueue(chunk);
      },
      async flush() {
        if (full) await stub.appendMessage({ role: "assistant", content: full });
      },
    }),
  );
  return { stream, logId: reply.logId };
}

/** Prepends a raw byte chunk (e.g. an SSE frame) before the rest of a byte stream. */
function prependBytes(source: ReadableStream<Uint8Array>, prefix: Uint8Array): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function staticTextStream(text: string): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      controller.enqueue(text);
      controller.close();
    },
  });
}

/** Wraps a plain-text-chunk stream as `text/event-stream` frames the browser client understands. */
function sseEncoder(): TransformStream<string, Uint8Array> {
  const encoder = new TextEncoder();
  return new TransformStream<string, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    },
    flush(controller) {
      controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
    },
  });
}

function getOrCreateSessionId(request: Request): { sessionId: string; setCookie: string | null } {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (match?.[1]) return { sessionId: match[1], setCookie: null };

  const sessionId = crypto.randomUUID();
  // `Secure` cookies are (correctly) refused by clients over plain HTTP, which
  // is what local `wrangler dev` uses -- only add it when actually on HTTPS
  // (production, behind the Custom Domain), or every local session would silently
  // "forget" itself on the very next request.
  const isHttps = new URL(request.url).protocol === "https:";
  const attrs = ["Path=/", "SameSite=Lax", "HttpOnly", `Max-Age=${60 * 60 * 24 * 30}`];
  if (isHttps) attrs.push("Secure");
  const setCookie = `${SESSION_COOKIE}=${sessionId}; ${attrs.join("; ")}`;
  return { sessionId, setCookie };
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
