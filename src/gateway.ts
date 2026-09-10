/**
 * Helpers for the AI Gateway "Resilience Lab" demo (Build-Plan-Chatbot.md
 * checklist items 22-23) and, later, the /insights panel's REST/Analytics
 * calls (item 24). Kept separate from claude.ts, which is the main chat's
 * everyday code path -- this file is only touched by the admin-only demo
 * surface, so the everyday path stays simple.
 *
 * Fallback demo: a Dynamic Route ("pgc-resilience-outage-demo") configured
 * in the dashboard/API with an intentionally-invalid primary Anthropic
 * model, so it deterministically falls back to Workers AI every time --
 * a reliable, repeatable way to demo "provider goes down, zero downtime"
 * without depending on a real outage.
 *
 * A/B demo: Dynamic Routing's "percentage" node turned out to error at
 * request time in this account even with a config matching the documented
 * schema exactly (confirmed: the same account/gateway's "model chain"
 * fallback route works fine, only the percentage-split node fails). Rather
 * than depend on that, the split is decided in this Worker and each variant
 * is called directly through the Gateway's OpenAI-compatible endpoint
 * (`{provider}/{model}` addressing) -- still logged, cached, and
 * spend-limited by the Gateway like any other request, just the routing
 * decision lives in code instead of dashboard config.
 */

import type { Env } from "./types";

const DEMO_PROMPT = "Give one short, fun fact about coffee in a single sentence.";
const OUTAGE_DEMO_ROUTE = "dynamic/pgc-resilience-outage-demo";
const AB_VARIANTS = [
  { label: "A: Claude Haiku", model: "anthropic/claude-haiku-4-5-20251001" },
  { label: "B: Workers AI Llama 3.3", model: "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast" },
] as const;

export interface DemoCallResult {
  label: string;
  provider: string | null;
  model: string | null;
  step: string | null;
  cached: boolean;
  text: string;
}

function compatUrl(env: Env): string {
  return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_AI_GATEWAY_ID}/compat/chat/completions`;
}

/** Calls the OpenAI-compatible endpoint with an explicit `model` string (either `dynamic/<route>` or `{provider}/{model}`). */
async function callCompat(env: Env, model: string, label: string): Promise<DemoCallResult> {
  const res = await fetch(compatUrl(env), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-aig-authorization": `Bearer ${env.CF_AIG_TOKEN}`,
      // x-api-key authenticates the Anthropic branch; Authorization (a
      // Cloudflare API token) is what the Workers AI branch needs when
      // addressed directly like this (Dynamic Routing/env.AI don't need it,
      // but calling `workers-ai/<model>` straight through the compat
      // endpoint does). Harmless to send both on every call.
      "x-api-key": env.ANTHROPIC_API_KEY,
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
    },
    body: JSON.stringify({
      model,
      // A random nonce keeps each call's request body unique, so repeated
      // demo clicks don't just replay the Gateway's exact-match cache --
      // that would make the A/B split look rigged (always the same cached
      // branch) and would hide the outage demo's live fallback behavior.
      messages: [{ role: "user", content: `${DEMO_PROMPT} (ref: ${crypto.randomUUID().slice(0, 8)})` }],
      max_tokens: 100,
    }),
  });

  const provider = res.headers.get("cf-aig-provider");
  const respModel = res.headers.get("cf-aig-model");
  const step = res.headers.get("cf-aig-step");
  const cached = res.headers.get("cf-aig-cache-status") === "HIT";

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { label, provider, model: respModel, step, cached, text: `(error ${res.status}: ${detail.slice(0, 200)})` };
  }

  const data = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[] };
  return {
    label,
    provider,
    // The compat endpoint doesn't always echo cf-aig-model for direct
    // {provider}/{model} calls (only reliably present for Dynamic Routes),
    // so fall back to the model the response body itself reports.
    model: respModel ?? data.model ?? null,
    step,
    cached,
    text: data.choices?.[0]?.message?.content ?? "(empty response)",
  };
}

/** "Simulate outage" -- calls the Dynamic Route whose primary model is intentionally broken. */
export async function runOutageDemo(env: Env): Promise<DemoCallResult> {
  return callCompat(env, OUTAGE_DEMO_ROUTE, "Outage simulation");
}

/** Runs one randomly-picked A/B variant, the way real traffic would be split. */
export async function runAbTestOnce(env: Env): Promise<DemoCallResult> {
  const variant = AB_VARIANTS[Math.floor(Math.random() * AB_VARIANTS.length)]!;
  return callCompat(env, variant.model, variant.label);
}
