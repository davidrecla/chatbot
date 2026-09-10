/**
 * Helpers for the AI Gateway "Resilience Lab" demo (Build-Plan-Chatbot.md
 * checklist items 22-23) and the /insights panel's REST/Analytics calls
 * (item 24). Kept separate from claude.ts, which is the main chat's
 * everyday code path -- this file is only touched by the admin-only demo
 * surface, so the everyday path stays simple.
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
 *
 * The "simulate provider outage" demo (a Dynamic Route,
 * "pgc-resilience-outage-demo", with an intentionally-invalid primary model
 * so it deterministically fell back to Workers AI) was retired -- no longer
 * used, and the route itself was deleted from the Gateway.
 */

import type { Env } from "./types";

const DEMO_PROMPT = "Give one short, fun fact about coffee in a single sentence.";
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

export function compatUrl(env: Env): string {
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

/** Runs one randomly-picked A/B variant, the way real traffic would be split. */
export async function runAbTestOnce(env: Env): Promise<DemoCallResult> {
  const variant = AB_VARIANTS[Math.floor(Math.random() * AB_VARIANTS.length)]!;
  return callCompat(env, variant.model, variant.label);
}

// ---------------------------------------------------------------------------
// /insights summary (checklist item 24) -- aggregates the most recent log
// entries via the REST API into the numbers the admin panel displays.
// Simple recent-window aggregation rather than the full GraphQL Analytics
// API, which is plenty for a live "here's what's happening" dashboard.
// ---------------------------------------------------------------------------

interface GatewayLog {
  id: string;
  provider: string | null;
  model: string | null;
  cost: number | null;
  cached: boolean | null;
  success: boolean | null;
  duration: number | null;
  feedback: number | null;
  created_at: string;
}

export interface InsightsSummary {
  windowSize: number;
  totalRequests: number;
  cacheHitRate: number;
  totalCost: number;
  avgDurationMs: number;
  errorCount: number;
  feedback: { up: number; down: number; none: number };
  modelBreakdown: { model: string; count: number }[];
  recentLogs: {
    id: string;
    provider: string | null;
    model: string | null;
    cost: number | null;
    cached: boolean | null;
    success: boolean | null;
    feedback: number | null;
    created_at: string;
  }[];
}

const INSIGHTS_WINDOW_SIZE = 50; // API max for per_page

export async function fetchInsightsSummary(env: Env): Promise<InsightsSummary> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways/${env.CF_AI_GATEWAY_ID}` +
    `/logs?per_page=${INSIGHTS_WINDOW_SIZE}&order_by=created_at&order_by_direction=desc`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } });
  if (!res.ok) {
    throw new Error(`Gateway logs request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { result?: GatewayLog[] };
  const logs = data.result ?? [];

  const modelCounts = new Map<string, number>();
  let cachedCount = 0;
  let errorCount = 0;
  let totalCost = 0;
  let totalDuration = 0;
  let durationSamples = 0;
  const feedback = { up: 0, down: 0, none: 0 };

  for (const log of logs) {
    if (log.cached) cachedCount++;
    if (log.success === false) errorCount++;
    if (typeof log.cost === "number") totalCost += log.cost;
    if (typeof log.duration === "number") {
      totalDuration += log.duration;
      durationSamples++;
    }
    if (log.feedback === 1) feedback.up++;
    else if (log.feedback === -1) feedback.down++;
    else feedback.none++;

    // Some log entries' `model` already includes a provider prefix (e.g.
    // compat-endpoint calls report "anthropic/claude-haiku-4.5"); others
    // report a bare model id and need `provider` prepended ourselves.
    const modelKey = log.model ? (log.model.includes("/") ? log.model : `${log.provider ?? "?"}/${log.model}`) : "(unknown)";
    modelCounts.set(modelKey, (modelCounts.get(modelKey) ?? 0) + 1);
  }

  return {
    windowSize: INSIGHTS_WINDOW_SIZE,
    totalRequests: logs.length,
    cacheHitRate: logs.length ? cachedCount / logs.length : 0,
    totalCost,
    avgDurationMs: durationSamples ? totalDuration / durationSamples : 0,
    errorCount,
    feedback,
    modelBreakdown: [...modelCounts.entries()]
      .map(([model, count]) => ({ model, count }))
      .sort((a, b) => b.count - a.count),
    recentLogs: logs.slice(0, 15).map((l) => ({
      id: l.id,
      provider: l.provider,
      model: l.model,
      cost: l.cost,
      cached: l.cached,
      success: l.success,
      feedback: l.feedback,
      created_at: l.created_at,
    })),
  };
}

// ---------------------------------------------------------------------------
// Single-log "conversation" view -- the raw log detail buries the actual
// back-and-forth inside a `request_head` JSON string that also contains the
// full system prompt (the whole knowledge base), making it unreadable for a
// demo. This extracts just the prior turns + this log's own reply.
// ---------------------------------------------------------------------------

export interface LogConversationTurn {
  role: string;
  content: string;
}

export interface LogConversation {
  id: string;
  created_at: string;
  success: boolean | null;
  cost: number | null;
  /** Prior turns sent as context for this request (system prompt excluded). */
  messages: LogConversationTurn[];
  /** The reply this specific request produced, if any (null if blocked/errored). */
  finalReply: string | null;
}

export async function fetchLogConversation(env: Env, logId: string): Promise<LogConversation> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways/${env.CF_AI_GATEWAY_ID}/logs/${logId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } });
  if (!res.ok) {
    throw new Error(`Gateway log detail request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { result?: Record<string, unknown> };
  const log = data.result ?? {};

  let messages: LogConversationTurn[] = [];
  try {
    const reqBody = JSON.parse(String(log.request_head ?? "{}")) as { messages?: LogConversationTurn[] };
    messages = reqBody.messages ?? [];
  } catch {
    // Truncated/unparseable request_head -- leave empty rather than error out.
  }

  let finalReply: string | null = null;
  try {
    const resBody = JSON.parse(String(log.response_head ?? "{}")) as { content?: string };
    finalReply = resBody.content ?? null;
  } catch {
    // Blocked/errored requests often have no parseable response_head.
  }

  return {
    id: String(log.id ?? logId),
    created_at: String(log.created_at ?? ""),
    success: typeof log.success === "boolean" ? log.success : null,
    cost: typeof log.cost === "number" ? log.cost : null,
    messages,
    finalReply,
  };
}
