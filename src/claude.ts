/**
 * Model-agnostic streaming chat client, built on the AI Gateway's
 * OpenAI-compatible endpoint (`compat/chat/completions`). Originally this
 * file was Anthropic-only (native `/v1/messages`); it's now generalized so
 * the main chat path can route between multiple tiers/models (see
 * src/modelRouting.ts) through a single code path -- Claude Sonnet, Claude
 * Haiku, and a Workers AI model are all addressed the same way, as
 * `{provider}/{model}` strings on the same endpoint.
 */

import { compatUrl } from "./gateway";
import type { ChatMessage, Env } from "./types";

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
   * the model again. Only worth setting for requests where a cached answer
   * is genuinely fine to reuse across different people -- see how
   * src/index.ts decides when to pass one.
   */
  cacheKey?: string;
  /** Cache TTL in seconds, only meaningful alongside `cacheKey`. */
  cacheTtlSeconds?: number;
}

function chatHeaders(env: Env, options?: GatewayRequestOptions): HeadersInit {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // x-api-key authenticates the Anthropic branch; Authorization (a
  // Cloudflare API token) is what the Workers AI branch needs when
  // addressed directly like this. Harmless to send both regardless of
  // which tier/model a given call is actually using.
  headers["x-api-key"] = env.ANTHROPIC_API_KEY;
  if (env.CF_API_TOKEN) headers["Authorization"] = `Bearer ${env.CF_API_TOKEN}`;

  // Everything below only makes sense (and is only sent) once the Worker is
  // actually routed through the Gateway, i.e. CF_AIG_TOKEN is set.
  if (!env.CF_AIG_TOKEN) return headers;
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
 * Streams a chat response as a sequence of plain UTF-8 text chunks (just
 * the assistant's text deltas, no SSE framing) via a TransformStream applied
 * to the compat endpoint's OpenAI-style SSE response. The caller
 * (src/index.ts) re-wraps this into whatever wire format the browser expects.
 */
export async function streamModelReply(
  env: Env,
  model: string,
  systemPrompt: string,
  messages: ChatMessage[],
  options?: GatewayRequestOptions,
): Promise<ClaudeReply> {
  const res = await fetch(compatUrl(env), {
    method: "POST",
    headers: chatHeaders(env, options),
    body: JSON.stringify({
      model,
      max_tokens: Number(env.ANTHROPIC_MAX_TOKENS) || 1024,
      messages: [{ role: "system", content: systemPrompt }, ...messages.map((m) => ({ role: m.role, content: m.content }))],
      stream: true,
    }),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new ClaudeApiError(res.status, `Model API error (${res.status}): ${detail.slice(0, 500)}`);
  }

  return {
    stream: res.body.pipeThrough(new TextDecoderStream()).pipeThrough(sseTextDeltaExtractor()),
    logId: res.headers.get("cf-aig-log-id"),
  };
}

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

/**
 * Parses an OpenAI-style chat completions SSE stream (`choices[0].delta.content`,
 * terminated by a `data: [DONE]` sentinel) and emits only the text deltas.
 */
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
        if (!json || json === "[DONE]") continue;
        try {
          const event = JSON.parse(json) as { choices?: { delta?: { content?: string } }[] };
          const text = event.choices?.[0]?.delta?.content;
          if (text) controller.enqueue(stripLongDashes(text));
        } catch {
          // Ignore malformed/partial SSE frames -- next chunk will complete them.
        }
      }
    },
  });
}
