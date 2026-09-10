/**
 * Shared types for the Worker. Kept separate from wrangler's generated
 * worker-configuration.d.ts (run `npm run cf-typegen` to regenerate that)
 * so hand-written app types don't get clobbered.
 */

import type { ChatSession } from "./session";

export interface Env {
  ASSETS: Fetcher;
  CHAT_SESSION: DurableObjectNamespace<ChatSession>;

  // --- Non-secret vars (wrangler.jsonc `vars`) ---
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_MODEL: string;
  ANTHROPIC_MAX_TOKENS: string;

  // --- Secrets (`wrangler secret put ...`) ---
  ANTHROPIC_API_KEY: string;

  // --- Phase 2 only (unset in Phase 1) ---
  CF_AIG_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_AI_GATEWAY_ID?: string;
  CF_API_TOKEN?: string;
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Body accepted by POST /api/chat */
export interface ChatRequestBody {
  message: string;
}
