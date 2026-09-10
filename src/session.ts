/**
 * Per-visitor chat history, keyed by a session cookie (see src/index.ts).
 * Called directly via Workers RPC (env.CHAT_SESSION.get(id).appendMessage(...))
 * rather than manual fetch() dispatch.
 *
 * MAX_MESSAGES was a tight Phase-1-only abuse/cost safeguard (40, ~20 turns)
 * before real protection existed. Retired per Build-Plan-Chatbot.md checklist
 * item 18: the AI Gateway now enforces a real per-session spend limit
 * ($0.50/day, scoped by the session_id metadata in src/claude.ts) and a
 * gateway-wide rate limit (30 req/min), so this is now just a generous
 * backstop against unbounded Durable Object storage growth, not the primary
 * defense.
 */

import { DurableObject } from "cloudflare:workers";
import type { ChatMessage, Env } from "./types";

const MAX_MESSAGES = 200; // ~100 user/assistant turns

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
