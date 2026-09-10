/**
 * Multi-model tier routing for the main chat path. Three tiers, each a
 * different model, escalate-only per session (never downgrades mid-
 * conversation -- see src/session.ts, which stores and escalates the tier).
 *
 * Deliberately excludes a 4th "Taglish -> different model" tier that was
 * explored and rejected: Qwen3 (Workers AI) was tested against the real
 * system prompt on 5 real Taglish questions and inconsistently swung
 * between full English (ignoring the mirror-language rule) and stiff
 * formal Tagalog (not the "mostly English + connector words" register the
 * brand voice defines) -- Claude (both tiers) already handles Taglish
 * correctly and consistently, so language is not a routing axis here.
 */

export type Tier = "trivial" | "standard" | "complex";

const TIER_ORDER: Tier[] = ["trivial", "standard", "complex"];

export interface TierConfig {
  /** `{provider}/{model}` string for the Gateway's compat endpoint. */
  model: string;
  /** Shown in the UI's model indicator. */
  label: string;
}

export const TIER_CONFIG: Record<Tier, TierConfig> = {
  trivial: { model: "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "Llama 3.3 (Workers AI)" },
  standard: { model: "anthropic/claude-haiku-4-5-20251001", label: "Claude Haiku" },
  complex: { model: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet" },
};

// Signals a bulk/business-buyer conversation -- escalate straight to the
// most capable tier, since a real order is potentially on the line.
const BUSINESS_KEYWORDS = /\b(kg|kilo|bulk|wholesale|caf[eé]|coffee\s*shop|business|bundle|office)\b/i;

// A conversation this long has already invested real back-and-forth;
// escalating protects against a mid-thread quality/voice drop (see
// Build-Plan-Chatbot.md's "escalate-only" design note).
const LONG_CONVERSATION_MESSAGE_COUNT = 6; // ~3 user/assistant turns

function isHighStakes(message: string, historyLengthBeforeThisMessage: number): boolean {
  return BUSINESS_KEYWORDS.test(message) || historyLengthBeforeThisMessage >= LONG_CONVERSATION_MESSAGE_COUNT;
}

const TRIVIAL_MAX_LENGTH = 60;

function isTrivial(message: string, historyLengthBeforeThisMessage: number): boolean {
  return historyLengthBeforeThisMessage === 0 && message.length < TRIVIAL_MAX_LENGTH;
}

/**
 * Classifies a single new user message into a tier. Deterministic (same
 * message + same prior history length always yields the same tier) --
 * "unpredictable" here means content-dependent, not random.
 */
export function classifyTier(message: string, historyLengthBeforeThisMessage: number): Tier {
  if (isHighStakes(message, historyLengthBeforeThisMessage)) return "complex";
  if (isTrivial(message, historyLengthBeforeThisMessage)) return "trivial";
  return "standard";
}

/** Escalate-only: a session's tier can only move up, never down. */
export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}
