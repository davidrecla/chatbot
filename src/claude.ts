/**
 * Thin Claude (Anthropic Messages API) client.
 *
 * Deliberately reads its target URL and auth headers from `Env` rather than
 * hardcoding `api.anthropic.com` -- Phase 2 (AI Gateway) is meant to be a
 * config change here, not a rewrite. See Build-Plan-Chatbot.md checklist
 * item 15: putting the Gateway in the loop is just setting
 * ANTHROPIC_BASE_URL to the Gateway's Anthropic-compatible endpoint and
 * adding a `cf-aig-authorization` header -- both handled below already,
 * gated on whether CF_AIG_TOKEN is set.
 */

import type { ChatMessage, Env } from "./types";

const ANTHROPIC_VERSION = "2023-06-01";

export class ClaudeApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ClaudeApiError";
  }
}

export interface GatewayRequestOptions {
  /** Attached to the Gateway's log entry for this request (User Insights). */
  metadata?: Record<string, string>;
  /**
   * A stable key so semantically-identical requests (e.g. the same opening
   * FAQ from different visitors) hit the Gateway's cache instead of calling
   * Anthropic again. Only worth setting for requests where a cached answer
   * is genuinely fine to reuse across different people -- see how
   * src/index.ts decides when to pass one.
   */
  cacheKey?: string;
  /** Cache TTL in seconds, only meaningful alongside `cacheKey`. */
  cacheTtlSeconds?: number;
}

function anthropicHeaders(env: Env, options?: GatewayRequestOptions): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    "x-api-key": env.ANTHROPIC_API_KEY,
  };
  // Everything below only makes sense (and is only sent) once the Worker is
  // actually routed through the Gateway, i.e. CF_AIG_TOKEN is set.
  if (!env.CF_AIG_TOKEN) return headers;

  // Authenticates the request to the gateway itself (separate from the
  // x-api-key above, which authenticates to Anthropic).
  headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;

  if (options?.metadata) {
    headers["cf-aig-metadata"] = JSON.stringify(options.metadata);
  }
  if (options?.cacheKey) {
    headers["cf-aig-cache-key"] = options.cacheKey;
    if (options.cacheTtlSeconds) {
      headers["cf-aig-cache-ttl"] = String(options.cacheTtlSeconds);
    }
  }
  return headers;
}

export interface ClaudeReply {
  stream: ReadableStream<string>;
  /**
   * The Gateway's `cf-aig-log-id` for this request, if routed through the
   * Gateway -- lets the client later attach 👍/👎 feedback to this exact
   * log entry via `POST /api/feedback` (see src/index.ts and patchLog in
   * the AI binding).
   */
  logId: string | null;
}

/**
 * Streams a Claude response as a sequence of plain UTF-8 text chunks (just
 * the assistant's text deltas, no SSE framing) via a TransformStream applied
 * to Anthropic's own SSE response. The caller (src/index.ts) re-wraps this
 * into whatever wire format the browser expects.
 */
export async function streamClaudeReply(
  env: Env,
  systemPrompt: string,
  messages: ChatMessage[],
  options?: GatewayRequestOptions,
): Promise<ClaudeReply> {
  const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: anthropicHeaders(env, options),
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL,
      max_tokens: Number(env.ANTHROPIC_MAX_TOKENS) || 1024,
      system: systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new ClaudeApiError(res.status, `Anthropic API error (${res.status}): ${detail.slice(0, 500)}`);
  }

  return {
    stream: res.body.pipeThrough(new TextDecoderStream()).pipeThrough(sseTextDeltaExtractor()),
    logId: res.headers.get("cf-aig-log-id"),
  };
}

/**
 * Parses an Anthropic Messages API SSE stream and emits only the text
 * content of `content_block_delta` (`text_delta`) events.
 */
/**
 * Safety net on top of the system prompt's "never use em/en dashes"
 * instruction, since it's a strong LLM habit that doesn't always fully go
 * away with a prompt alone. "word — word" -> "word, word"; a bare dash used
 * as a minus/range (e.g. "10-20kg") is left alone since that's a hyphen, not
 * an em/en dash.
 */
function stripLongDashes(text: string): string {
  return text.replace(/\s*[\u2013\u2014]\s*/g, ", ");
}

function sseTextDeltaExtractor(): TransformStream<string, string> {
  let buffer = "";
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      buffer += chunk;
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const rawEvent of events) {
        const dataLine = rawEvent.split("\n").find((line) => line.startsWith("data:"));
        if (!dataLine) continue;
        const json = dataLine.slice("data:".length).trim();
        if (!json) continue;
        try {
          const event = JSON.parse(json) as {
            type?: string;
            delta?: { type?: string; text?: string };
          };
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            controller.enqueue(stripLongDashes(event.delta.text ?? ""));
          }
        } catch {
          // Ignore malformed/partial SSE frames -- next chunk will complete them.
        }
      }
    },
  });
}
