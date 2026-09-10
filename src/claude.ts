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

function anthropicHeaders(env: Env): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    "x-api-key": env.ANTHROPIC_API_KEY,
  };
  // Phase 2: once the Worker is pointed at the AI Gateway, CF_AIG_TOKEN is
  // set and this header authenticates the request to the gateway itself
  // (separate from the x-api-key above, which authenticates to Anthropic).
  if (env.CF_AIG_TOKEN) {
    headers["cf-aig-authorization"] = `Bearer ${env.CF_AIG_TOKEN}`;
  }
  return headers;
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
): Promise<ReadableStream<string>> {
  const res = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: anthropicHeaders(env),
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

  return res.body.pipeThrough(new TextDecoderStream()).pipeThrough(sseTextDeltaExtractor());
}

/**
 * Parses an Anthropic Messages API SSE stream and emits only the text
 * content of `content_block_delta` (`text_delta`) events.
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
        if (!json) continue;
        try {
          const event = JSON.parse(json) as {
            type?: string;
            delta?: { type?: string; text?: string };
          };
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            controller.enqueue(event.delta.text ?? "");
          }
        } catch {
          // Ignore malformed/partial SSE frames -- next chunk will complete them.
        }
      }
    },
  });
}
