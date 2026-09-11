/**
 * Assembles the chatbot's system prompt from the brand voice guide, a
 * retrieved subset of the generated site knowledge doc, and explicit
 * operating rules. brand-voice.md is baked into the Worker bundle at build
 * time as a plain string (see wrangler.jsonc's Text module rule +
 * src/md.d.ts); site-knowledge.md is *not* sent in full on every request
 * any more -- see the retrieval section below.
 */

import brandVoice from "../knowledge/brand-voice.md";
import siteKnowledge from "../knowledge/site-knowledge.md";
import type { ChatMessage, Env } from "./types";

// site-knowledge.md runs ~68KB (33 products, 12 collections, 3 policies, 6
// brewing-guide articles) -- sending all of it as the system prompt on every
// single message dominates latency (measured: +8-10s for Claude tiers, +2-3s
// for Workers AI tiers, vs. a trivial prompt) for content that's almost
// always irrelevant to the actual question asked. Instead, knowledge/
// site-knowledge.md is chunked and embedded into the "pgc-knowledge"
// Vectorize index by `npm run embed:knowledge` (run after build:knowledge
// any time the knowledge base changes -- see scripts/embed-knowledge.ts),
// and at request time we retrieve just the top-K chunks relevant to the
// current turn instead. Falls back to the full file if retrieval fails or
// comes back empty (never worse than the old always-send-everything
// behavior, just occasionally slower).
const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
const RETRIEVAL_TOP_K = 8;
// How many of the most recent messages to fold into the retrieval query --
// enough that a short follow-up ("what about light roasts?") still carries
// the topic from a message or two back, without diluting the query with the
// whole conversation.
const RETRIEVAL_CONTEXT_MESSAGES = 3;

// Deliberately minimal -- just identity + source-of-truth precedence. Every
// tone/style/sales-behavior rule (how to talk, when to bring up business
// bundle pricing, off-topic handling, etc.) lives once in brand-voice.md,
// not duplicated here. (It used to be duplicated across both files; see
// Build-Plan-Chatbot.md's Phase 2.8 note.)
const OPERATING_RULES = `
# Operating Rules

You are Pure Grounds Coffee Co.'s sales consultant, talking directly with a
customer on puregroundscoffee.com's chat. Pure Grounds is a specialty coffee
roastery in the Philippines. Answer using the "Site Knowledge" section below
as your source of truth, plus general, widely-known coffee/brewing knowledge
when it helps explain something (e.g. what "acidity" means). Never invent
Pure Grounds-specific facts, prices, or stock status that aren't in Site
Knowledge. Follow the tone, formatting, and sales approach described in
"Brand Voice" below on every reply.
`.trim();

/** Embeds the recent conversation and returns the top-K matching chunks of site-knowledge.md, joined. */
async function retrieveRelevantKnowledge(env: Env, history: ChatMessage[]): Promise<string> {
  const queryText = history
    .slice(-RETRIEVAL_CONTEXT_MESSAGES)
    .map((m) => m.content)
    .join("\n")
    .trim();
  if (!queryText) return siteKnowledge;

  const embedding = await env.AI.run(EMBEDDING_MODEL, { text: queryText });
  const vector = "data" in embedding ? embedding.data?.[0] : undefined;
  if (!vector) return siteKnowledge;

  // "all" (not the default "indexed") -- indexed-level metadata retrieval
  // can truncate large string fields, and the whole point here is getting
  // each chunk's full `text` back out.
  const { matches } = await env.VECTORIZE.query(vector, {
    topK: RETRIEVAL_TOP_K,
    returnMetadata: "all",
  });
  if (!matches.length) return siteKnowledge;

  const chunks = matches.map((match) => (match.metadata?.text as string | undefined) ?? "").filter(Boolean);
  return chunks.length ? chunks.join("\n\n---\n\n") : siteKnowledge;
}

export async function buildSystemPrompt(env: Env, history: ChatMessage[]): Promise<string> {
  let knowledge: string;
  try {
    knowledge = await retrieveRelevantKnowledge(env, history);
  } catch (err) {
    console.error("Knowledge retrieval failed, falling back to the full knowledge base:", err);
    knowledge = siteKnowledge;
  }
  return [OPERATING_RULES, "# Brand Voice", brandVoice, "# Site Knowledge", knowledge].join("\n\n");
}
