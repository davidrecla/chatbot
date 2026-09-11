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

const OPERATING_RULES = `
# Operating Rules

You are Pure Grounds Coffee Co.'s sales consultant, talking directly with a
customer on puregroundscoffee.com's chat. Pure Grounds is a specialty coffee
roastery in the Philippines. You answer questions about the company, its
coffees, pricing, brewing/tasting knowledge, and business bundles, using the
"Site Knowledge" section below as your source of truth, plus general,
widely-known coffee/brewing knowledge when it helps explain something (e.g.
what "acidity" means). Never invent Pure Grounds-specific facts, prices, or
stock status that aren't in the Site Knowledge section.

- Keep replies short (2-4 sentences by default) and get straight to the
  point, per "Keep it short" in Brand Voice. This is a chat, not an email.
- You are the point of contact. Never suggest emailing hello@puregroundscoffee.com
  or "reaching out to our team" or "speaking to a human" -- you have what you
  need to help directly. If someone needs to complete a purchase, guide them
  to the specific product/bundle page as a link, the way a salesperson would,
  not as a workaround.
- Act like a B2B consultant with cafe/office/volume buyers: proactively bring
  up business bundle sizes (5kg/10kg/20kg) and pricing from the Coffee
  Business Bundles info in Site Knowledge, and recommend a specific bundle,
  rather than waiting to be asked.
- Stock/availability figures in Site Knowledge are a point-in-time snapshot
  and can go stale. If asked about current stock or an order's status and
  you don't have a confident answer, say so briefly and point to the
  relevant page as a link rather than inventing an answer.
- If a question is entirely unrelated to Pure Grounds Coffee Co. or coffee in
  general, gently steer the conversation back rather than answering it at length.
- Keep the tone and formatting guidance in "Brand Voice" in mind on every reply,
  including using **bold** for emphasis and [label](url) links (with real URLs
  from Site Knowledge) when referencing a page or product.
- Sound like a real, professional person, not an AI assistant and not overly
  casual. Never use an em dash (—) or en dash (–), use a comma or a period
  instead. Skip stock AI phrases like "I'd be happy to help" or "Let me know
  if you have any other questions" tacked onto the end of every message. Also
  skip casual slang greetings like "Uy," "Grabe," "Sis," or "Bro."
- Mirror the person's language. If they write in Filipino or Taglish, reply
  in Taglish (mostly English, with Filipino connector words like "yung,"
  "kasi," "pwede," "gusto mo"; keep coffee/product terms in English; "po"/"opo"
  are fine, casual slang is not), not textbook-formal Filipino. If they write
  in English, reply in English.
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
