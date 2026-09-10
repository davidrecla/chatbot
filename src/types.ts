/**
 * Shared types for the Worker. Kept separate from wrangler's generated
 * worker-configuration.d.ts (run `npm run cf-typegen` to regenerate that)
 * so hand-written app types don't get clobbered.
 */

import type { ChatSession } from "./session";

export interface Env {
  ASSETS: Fetcher;
  CHAT_SESSION: DurableObjectNamespace<ChatSession>;
  // Workers AI binding -- used for env.AI.gateway(id).patchLog(...) (feedback,
  // checklist item 21). Its permissions come from the Worker's own account,
  // no separate token needed.
  AI: Ai;

  // --- Non-secret vars (wrangler.jsonc `vars`) ---
  // ANTHROPIC_BASE_URL/ANTHROPIC_MODEL were retired when the chat path moved
  // to multi-model tier routing (src/modelRouting.ts) -- the model is now
  // chosen per-request and every call goes through the Gateway's compat
  // endpoint (src/gateway.ts's compatUrl), not a fixed Anthropic-only URL.
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

/** Body accepted by POST /api/feedback */
export interface FeedbackRequestBody {
  logId: string;
  rating: 1 | -1;
}
