import { ClaudeApiError, streamClaudeReply, type GatewayRequestOptions } from "./claude";
import { buildSystemPrompt } from "./knowledge";
import { ChatSession } from "./session";
import type { ChatMessage, ChatRequestBody, Env } from "./types";

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

  const textStream = limitReached
    ? staticTextStream(CAP_REACHED_MESSAGE)
    : await claudeReplyStream(env, history, stub, sessionId);

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  if (setCookie) headers.set("set-cookie", setCookie);

  return new Response(textStream.pipeThrough(sseEncoder()), { headers });
}

/** Streams Claude's reply and, once fully streamed, saves it as the session's assistant turn. */
async function claudeReplyStream(
  env: Env,
  history: ChatMessage[],
  stub: DurableObjectStub<ChatSession>,
  sessionId: string,
): Promise<ReadableStream<string>> {
  let claudeStream: ReadableStream<string>;
  try {
    claudeStream = await streamClaudeReply(env, buildSystemPrompt(), history, {
      metadata: { session_id: sessionId, surface: "public-chat" },
      ...openingQuestionCacheOptions(history),
    });
  } catch (err) {
    const message = err instanceof ClaudeApiError ? err.message : "Something went wrong reaching Claude.";
    console.error(err);
    return staticTextStream(`Sorry, I ran into a problem: ${message}`, "error");
  }

  let full = "";
  return claudeStream.pipeThrough(
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
}

function staticTextStream(text: string, tag: "text" | "error" = "text"): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      if (tag === "error") controller.error(new Error(text));
      else {
        controller.enqueue(text);
        controller.close();
      }
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
