/**
 * Multi-model tier routing for the main chat path. Four tiers, each a
 * different model, escalate-only per session (never downgrades mid-
 * conversation -- see src/session.ts, which stores and escalates the tier).
 *
 * Classification (which tier a message belongs to) happens here, in Worker
 * code, because AI Gateway's Dynamic Routing can't read free-text prompt
 * content -- its `conditional` node only branches on structured fields
 * (`metadata.*`). But the actual model **selection** is delegated to a
 * Dynamic Route ("pgc-tier-router", a chain of `conditional` nodes keyed on
 * `metadata.tier`) rather than resolved directly in this file -- see
 * DYNAMIC_ROUTE_MODEL below and how src/index.ts attaches `tier` via
 * `cf-aig-metadata`. This genuinely exercises the Gateway's routing
 * capability instead of just picking a model in our own code. Verified all
 * 4 branches resolve correctly in both streaming and non-streaming mode.
 * (Dynamic Routing's `percentage` node was unreliable in this account --
 * see Build-Plan-Chatbot.md item 22 -- but `conditional` chains hold up.)
 *
 * Order: trivial -> technical -> standard -> complex. Escalation is purely
 * positional in that list -- e.g. a technical conversation that just keeps
 * going (4+ messages) without any further technical question will still
 * get promoted to "standard" (Claude Haiku) on length alone, since standard
 * sits above technical in the ladder. That's intentional, not a bug: a
 * long-running technical thread is still more "invested" than a one-off
 * technical question and can stand a better model for a general follow-up.
 *
 * Deliberately excludes a "Taglish -> different model" tier that was
 * explored and rejected: Qwen3 (Workers AI) was tested against the real
 * system prompt on 5 real Taglish questions and inconsistently swung
 * between full English (ignoring the mirror-language rule) and stiff
 * formal Tagalog (not the "mostly English + connector words" register the
 * brand voice defines) -- Claude already handles Taglish correctly and
 * consistently, so language is not a routing axis here.
 */

export type Tier = "trivial" | "technical" | "standard" | "complex";

const TIER_ORDER: Tier[] = ["trivial", "technical", "standard", "complex"];

export interface TierConfig {
  /** Shown in the UI's model indicator -- what src/index.ts's own tier
   * classification implies will answer, once the Dynamic Route resolves it. */
  label: string;
}

// Every tier's actual model call goes through this one Dynamic Route --
// the route's own conditional chain (keyed on the `tier` value attached via
// cf-aig-metadata) does the real selection. See src/gateway.ts's comment
// for the route's element graph, or fetch it directly:
// GET /accounts/{account}/ai-gateway/gateways/{gateway}/routes/{id}
export const DYNAMIC_ROUTE_MODEL = "dynamic/pgc-tier-router";

export const TIER_CONFIG: Record<Tier, TierConfig> = {
  // Switched from llama-3.3-70b-instruct-fp8-fast after a head-to-head
  // benchmark against the real system prompt: Scout was 30-90% faster and
  // matched or beat 3.3 on accuracy (it caught an out-of-stock detail 3.3
  // missed, and was more proactively helpful on a bundle-pricing question).
  trivial: { label: "Llama 4 Scout (Workers AI)" },
  // Benchmarked against deepseek-v4-flash-0731 (returned an empty response
  // on a technical question -- reliability concern) and
  // deepseek-r1-distill-qwen-32b (107s response time, leaked raw <think>
  // reasoning into the reply). gpt-oss-120b was fast and accurate on a
  // real coffee-extraction-theory question.
  technical: { label: "GPT-OSS 120B (Workers AI)" },
  standard: { label: "Claude Haiku" },
  complex: { label: "Claude Sonnet" },
};

// Signals a bulk/business-buyer conversation -- escalate straight to the
// most capable tier, since a real order is potentially on the line. Matches
// e.g. "10kg" (a concrete quantity) as well as "bulk"/"wholesale"/"business".
const BUSINESS_KEYWORDS = /\b(kg|kilo|bulk|wholesale|caf[eé]|coffee\s*shop|business|bundle|office)\b/i;

// A conversation this long has already invested real back-and-forth;
// escalating protects against a mid-thread quality/voice drop (see
// Build-Plan-Chatbot.md's "escalate-only" design note).
const LONG_CONVERSATION_MESSAGE_COUNT = 12; // ~6 user/assistant turns

function isComplex(message: string, historyLengthBeforeThisMessage: number): boolean {
  return BUSINESS_KEYWORDS.test(message) || historyLengthBeforeThisMessage >= LONG_CONVERSATION_MESSAGE_COUNT;
}

// A message asking *how* or *why* something works, not just asking *what*
// it is/costs -- these benefit from a model that explains mechanisms well.
const TECHNICAL_KEYWORDS =
  /\b(explain|how does|how do|why does|why is|extraction|ratio|grind|brew time|roast level|processing|process|acidity|mouthfeel|body|fermentation)\b/i;

function isTechnical(message: string): boolean {
  return TECHNICAL_KEYWORDS.test(message);
}

// Below this, a conversation is still "just starting" -- basic questions
// about coffee, the company, or products stay on the cheapest tier.
const TRIVIAL_MAX_HISTORY = 4; // ~2 user/assistant turns

/**
 * Classifies a single new user message into a tier. Deterministic (same
 * message + same prior history length always yields the same tier) --
 * "unpredictable" here means content-dependent, not random. Checked in
 * priority order: complex signals override everything, then a technical
 * question, then plain conversation depth decides trivial vs. standard.
 */
export function classifyTier(message: string, historyLengthBeforeThisMessage: number): Tier {
  if (isComplex(message, historyLengthBeforeThisMessage)) return "complex";
  if (isTechnical(message)) return "technical";
  if (historyLengthBeforeThisMessage < TRIVIAL_MAX_HISTORY) return "trivial";
  return "standard";
}

/** Escalate-only: a session's tier can only move up (in TIER_ORDER), never down. */
export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}
