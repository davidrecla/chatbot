import { ClaudeApiError, streamClaudeReply } from "./claude";
import { buildSystemPrompt } from "./knowledge";
import { ChatSession } from "./session";
import type { ChatMessage, ChatRequestBody, Env } from "./types";

export { ChatSession };

const SESSION_COOKIE = "pgc_session";
const MAX_MESSAGE_LENGTH = 2000;
const CAP_REACHED_MESSAGE =
  "You've reached the message limit for this chat session. Please refresh the page to start a new conversation -- or reach out to hello@puregroundscoffee.com, happy to help there!";

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
    : await claudeReplyStream(env, history, stub);

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
): Promise<ReadableStream<string>> {
  let claudeStream: ReadableStream<string>;
  try {
    claudeStream = await streamClaudeReply(env, buildSystemPrompt(), history);
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
