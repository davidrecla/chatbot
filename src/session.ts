/**
 * Per-visitor chat history, keyed by a session cookie (see src/index.ts).
 * Called directly via Workers RPC (env.CHAT_SESSION.get(id).appendMessage(...))
 * rather than manual fetch() dispatch.
 *
 * MAX_MESSAGES is an interim, Phase-1-only abuse/cost safeguard -- there's no
 * real rate limiting yet since that arrives with AI Gateway in Phase 2
 * (Build-Plan-Chatbot.md checklist item 18), so we cap history length here
 * in the meantime rather than shipping with no ceiling at all.
 */

import { DurableObject } from "cloudflare:workers";
import type { ChatMessage, Env } from "./types";

const MAX_MESSAGES = 40; // ~20 user/assistant turns

export class ChatSession extends DurableObject<Env> {
  async getHistory(): Promise<ChatMessage[]> {
    return (await this.ctx.storage.get<ChatMessage[]>("messages")) ?? [];
  }

  /** Appends a message and returns the (possibly trimmed) full history. */
  async appendMessage(message: ChatMessage): Promise<{ history: ChatMessage[]; limitReached: boolean }> {
    const history = await this.getHistory();
    history.push(message);
    const limitReached = history.length >= MAX_MESSAGES;
    const trimmed = history.slice(-MAX_MESSAGES);
    await this.ctx.storage.put("messages", trimmed);
    return { history: trimmed, limitReached };
  }

  async reset(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}
