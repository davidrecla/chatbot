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

export type Tier = "trivial" | "technical" | "standard" | "complex" | "guarded";

const TIER_ORDER: Tier[] = ["trivial", "technical", "standard", "complex", "guarded"];

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
  // Prompt-injection / instruction-extraction attempts. Same model as the
  // complex tier, but a deliberately separate tier so the escalation is
  // visible as its own branch in the Dynamic Route and filterable as
  // `metadata.tier = guarded` in the Gateway logs.
  guarded: { label: "Claude Sonnet (guarded)" },
};

// Prompt-injection and instruction-extraction attempts, which need the
// most instruction-hierarchy-resistant model available.
//
// Why this exists: an injection attempt is almost always the *opening*
// message of a session, which put it on the trivial tier (Llama 4 Scout).
// Measured against production before this was added, Scout leaked the
// entire system prompt verbatim (operating rules + the whole brand voice
// guide) on 4 of 5 probes. Claude refuses the same probes.
//
// This cannot be delegated to AI Gateway Guardrails' P1 category: on this
// gateway P1 flags ~100% of requests, benign ones included (measured
// 18/18, e.g. "What time do you open on Saturdays?"), because Guardrails
// scans the whole prompt -- our own instruction-heavy system prompt
// included -- not just the user's turn. So P1 has to stay on FLAG and
// can't be the enforcement point. See Build-Plan-Chatbot.md Phase 2.9.
//
// Patterns are deliberately narrow, requiring injection-specific structure
// rather than single suspicious words, so ordinary messages that merely
// contain "ignore" ("Ignore the milk, I want it black") don't escalate.
const INJECTION_PATTERNS: RegExp[] = [
  // "ignore/disregard/forget all previous instructions"
  /\b(ignore|disregard|forget|override|set aside|put aside|drop|bypass|discard)\b[^.?!]{0,40}\b(previous|prior|earlier|above|initial|original|all|your)\b[^.?!]{0,40}\b(instruction|rule|prompt|direction|guideline|polic|constraint)/i,
  // asking for the configuration by name
  /\b(system|initial|original|hidden|secret|internal)\s+(prompt|instruction|message|configuration)/i,
  /\b(reveal|disclose|print|paste|output|repeat|quote|dump|show)\b[^.?!]{0,30}\b(your|the)\b[^.?!]{0,25}\b(instruction|prompt|configuration|rules|knowledge base)/i,
  /\b(your|the)\b[^.?!]{0,25}\b(instruction|prompt|configuration)s?\b[^.?!]{0,30}\b(verbatim|word for word|in full|full text|exactly)/i,
  // "repeat the words above", "what were you told never to tell customers"
  /\brepeat\b[^.?!]{0,25}\b(words|text|everything)\b[^.?!]{0,25}\babove\b/i,
  // Asking about the instructions indirectly rather than for their text.
  // Worth being broad here: this class is what an unhardened model answers
  // most readily, and a non-disclosure rule in the system prompt actually
  // makes it *worse* (it hands the model an explicit list to read back).
  /\b(what|everything|anything|which)\b[^.?!]{0,30}\byou (were|was|'ve been|have been|are) (told|instructed|configured|programmed|designed|trained|asked|forbidden|not allowed)\b/i,
  /\byou (were|was|'ve been|have been) (told|instructed|configured|programmed|designed) (to|never|not)\b/i,
  // Same thing in question-inverted word order ("what WERE YOU told...",
  // "what ARE YOU not allowed to say"), which the patterns above miss
  // because they expect "you were told" contiguously.
  /\b(what|which|everything|anything)\b[^.?!]{0,20}\b(were|was|are|have|has|did)\s+you\s+(told|instructed|configured|programmed|designed|given|asked|forbidden)\b/i,
  /\b(are|were|is)\s+you\s+(not allowed|never allowed|forbidden|prohibited|unable|banned)\s+to\s+(say|tell|share|reveal|disclose|discuss|mention)\b/i,
  /\bnever\s+(share|tell|reveal|disclose|say|mention|discuss)\b[^.?!]{0,30}\b(customer|user|anyone|me)\b/i,
  /\byou\s+(can'?t|cannot|must not|aren'?t allowed to|are not allowed to|'?re not allowed to|are forbidden to|were forbidden to)\b[^.?!]{0,25}\b(say|tell|share|reveal|disclose|discuss|talk about)\b/i,
  // persona hijack / jailbreak framings
  /\b(you are now|from now on you are|act as|pretend (you are|to be)|roleplay as)\b[^.?!]{0,40}\b(dan|unlocked|unrestricted|jailbroken|no (content )?(policy|filter|restriction)|without (any )?(rules|restrictions|filters))/i,
  /\b(dan mode|developer mode|admin mode|god mode|sudo mode|jailbreak)\b/i,
  // fake system/admin framing smuggled into the user turn
  /(<{1,2}\/?sys(tem)?>{1,2}|\[\/?system\]|###\s*(end of )?(user|system)|<\|im_(start|end)\|>)/i,
  /\b(system override|administrator directive|admin override|system message|new directive)\b\s*:/i,
  // attempts to rewrite business rules by assertion
  /\b(new|updated)\s+(polic|directive|instruction|rule)\w*\b[^.?!]{0,45}\b(effective immediately|from now on|all orders (are )?free|confirm)/i,
];

function isInjectionAttempt(message: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(message));
}

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
 * priority order: an injection attempt outranks everything, then complex
 * signals, then a technical question, then plain conversation depth
 * decides trivial vs. standard.
 */
export function classifyTier(message: string, historyLengthBeforeThisMessage: number): Tier {
  if (isInjectionAttempt(message)) return "guarded";
  if (isComplex(message, historyLengthBeforeThisMessage)) return "complex";
  if (isTechnical(message)) return "technical";
  if (historyLengthBeforeThisMessage < TRIVIAL_MAX_HISTORY) return "trivial";
  return "standard";
}

/** Escalate-only: a session's tier can only move up (in TIER_ORDER), never down. */
export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}
