/**
 * Per-conversation state, keyed by the tab-scoped conversation id sent by
 * public/app.js. Called directly via Workers RPC rather than manual fetch()
 * dispatch.
 *
 * MAX_TRANSCRIPT_ENTRIES is a live-storage growth backstop. D1 retains the
 * complete customer-visible transcript for 30 days, while safe model context
 * is separately compacted to 10 exchanges plus a rolling summary.
 */

import { DurableObject } from "cloudflare:workers";
import { classifyTier, maxTier, type Tier } from "./modelRouting";
import { persistTranscriptEntries } from "./transcripts";
import type { ChatMessage, ChatRole, Env } from "./types";

const MAX_TRANSCRIPT_ENTRIES = 200;
const MODEL_CONTEXT_EXCHANGES = 10;
const CONVERSATION_IDLE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TIER: Tier = "trivial";

export type TranscriptOutcome = "allowed" | "guarded" | "blocked" | "failed";
export type TranscriptEnforcement = "application" | "guardrails" | "dlp";

export interface TranscriptSecurity {
  gatewayLogId: string | null;
  dlpAction: "FLAG" | "BLOCK" | null;
  dlpMatches: string[];
}

export interface TranscriptEntry {
  id: string;
  sequence: number;
  role: ChatRole;
  content: string;
  outcome: TranscriptOutcome;
  enforcement?: TranscriptEnforcement;
  gatewayLogId?: string;
  enrichmentStatus: "pending" | "complete" | "unavailable";
  guardrailAction?: "FLAG" | "BLOCK";
  guardrailCategories?: string[];
  dlpAction?: "FLAG" | "BLOCK";
  dlpMatches?: string[];
  createdAt: number;
}

export interface LiveTranscript {
  entries: TranscriptEntry[];
  expiresAt: number;
}

export interface SummaryJob {
  token: string;
  existingSummary: string;
  messages: ChatMessage[];
}

export class ChatSession extends DurableObject<Env> {
  private async flushPendingPersistence(): Promise<boolean> {
    const pending = (await this.ctx.storage.get<TranscriptEntry[]>("d1Pending")) ?? [];
    const conversationId = await this.ctx.storage.get<string>("conversationId");
    if (!pending.length) return true;
    if (!conversationId) return false;
    try {
      await persistTranscriptEntries(this.env.TRANSCRIPTS, conversationId, pending);
      await this.ctx.storage.delete("d1Pending");
      return true;
    } catch (err) {
      console.error("D1 transcript retry failed:", err);
      return false;
    }
  }

  private async touchExpiration(): Promise<number> {
    const now = Date.now();
    const currentExpiresAt = await this.ctx.storage.get<number>("expiresAt");
    if (currentExpiresAt && currentExpiresAt <= now) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.flushPendingPersistence();
    }
    const expiresAt = now + CONVERSATION_IDLE_TTL_MS;
    await this.ctx.storage.put("expiresAt", expiresAt);
    await this.ctx.storage.setAlarm(expiresAt);
    return expiresAt;
  }

  private async appendTranscript(
    conversationId: string,
    entries: Omit<TranscriptEntry, "sequence">[],
    expectedExpiresAt: number,
  ): Promise<boolean> {
    const expiresAt = await this.ctx.storage.get<number>("expiresAt");
    if (expiresAt !== expectedExpiresAt || Date.now() >= expectedExpiresAt) return false;
    const transcript = (await this.ctx.storage.get<TranscriptEntry[]>("transcript")) ?? [];
    let nextSequence =
      (await this.ctx.storage.get<number>("nextSequence")) ??
      transcript.reduce((highest, entry, index) => Math.max(highest, entry.sequence ?? index), -1) + 1;
    const sequenced = entries.map((entry) => ({ ...entry, sequence: nextSequence++ }));
    transcript.push(...sequenced);
    await this.ctx.storage.put({ conversationId, transcript: transcript.slice(-MAX_TRANSCRIPT_ENTRIES), nextSequence });
    try {
      await persistTranscriptEntries(this.env.TRANSCRIPTS, conversationId, sequenced);
    } catch (err) {
      console.error("D1 transcript write failed:", err);
      const pending = (await this.ctx.storage.get<TranscriptEntry[]>("d1Pending")) ?? [];
      await this.ctx.storage.put("d1Pending", [...pending, ...sequenced]);
    }
    return true;
  }

  /**
   * Builds tentative model context without persisting the new user message.
   * The caller records the customer-visible outcome after the attempt ends.
   */
  async prepareMessage(message: string): Promise<{
    history: ChatMessage[];
    summary: string;
    limitReached: boolean;
    tier: Tier;
    expiresAt: number;
  }> {
    const expiresAt = await this.touchExpiration();
    const history = (await this.ctx.storage.get<ChatMessage[]>("messages")) ?? [];
    const transcript = (await this.ctx.storage.get<TranscriptEntry[]>("transcript")) ?? [];
    const summary = (await this.ctx.storage.get<string>("summary")) ?? "";
    const summaryPending = Boolean(await this.ctx.storage.get<string>("summaryPendingToken"));
    const currentTier = (await this.ctx.storage.get<Tier>("tier")) ?? DEFAULT_TIER;
    const tier = maxTier(currentTier, classifyTier(message, history.length));
    const pending: ChatMessage = { role: "user", content: message };
    const contextSize = MODEL_CONTEXT_EXCHANGES * 2;
    const recentHistory = summaryPending || history.length > contextSize ? history : history.slice(-contextSize);
    return {
      history: [...recentHistory, pending],
      summary,
      limitReached: transcript.length + 1 >= MAX_TRANSCRIPT_ENTRIES,
      tier,
      expiresAt,
    };
  }

  async commitExchange(
    conversationId: string,
    userContent: string,
    assistantContent: string,
    tier: Tier,
    security: TranscriptSecurity,
    expectedExpiresAt: number,
  ): Promise<SummaryJob | null> {
    const now = Date.now();
    const accepted = await this.appendTranscript(
      conversationId,
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          content: userContent,
          outcome: "allowed",
          ...(security.gatewayLogId ? { gatewayLogId: security.gatewayLogId } : {}),
          enrichmentStatus: security.gatewayLogId ? "pending" : "unavailable",
          ...(security.dlpAction ? { dlpAction: security.dlpAction } : {}),
          ...(security.dlpMatches.length ? { dlpMatches: security.dlpMatches } : {}),
          createdAt: now,
        },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: assistantContent,
          outcome: "allowed",
          ...(security.gatewayLogId ? { gatewayLogId: security.gatewayLogId } : {}),
          enrichmentStatus: security.gatewayLogId ? "pending" : "unavailable",
          createdAt: now,
        },
      ],
      expectedExpiresAt,
    );
    if (!accepted) return null;

    const history = (await this.ctx.storage.get<ChatMessage[]>("messages")) ?? [];
    history.push({ role: "user", content: userContent }, { role: "assistant", content: assistantContent });
    await this.ctx.storage.put("messages", history);
    const currentTier = (await this.ctx.storage.get<Tier>("tier")) ?? DEFAULT_TIER;
    await this.ctx.storage.put("tier", maxTier(currentTier, tier));

    const summaryPending = await this.ctx.storage.get<string>("summaryPendingToken");
    const overflowCount = history.length - MODEL_CONTEXT_EXCHANGES * 2;
    if (summaryPending || overflowCount <= 0) return null;

    const token = crypto.randomUUID();
    await this.ctx.storage.put({ summaryPendingToken: token, summaryPendingCount: overflowCount });
    return {
      token,
      existingSummary: (await this.ctx.storage.get<string>("summary")) ?? "",
      messages: history.slice(0, overflowCount),
    };
  }

  async recordGuardedExchange(
    conversationId: string,
    userContent: string,
    assistantContent: string,
    security: TranscriptSecurity,
    expectedExpiresAt: number,
  ): Promise<void> {
    const now = Date.now();
    await this.appendTranscript(
      conversationId,
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          content: userContent,
          outcome: "guarded",
          enforcement: "application",
          ...(security.gatewayLogId ? { gatewayLogId: security.gatewayLogId } : {}),
          enrichmentStatus: security.gatewayLogId ? "pending" : "unavailable",
          guardrailAction: "FLAG",
          guardrailCategories: ["P1"],
          ...(security.dlpAction ? { dlpAction: security.dlpAction } : {}),
          ...(security.dlpMatches.length ? { dlpMatches: security.dlpMatches } : {}),
          createdAt: now,
        },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: assistantContent,
          outcome: "allowed",
          ...(security.gatewayLogId ? { gatewayLogId: security.gatewayLogId } : {}),
          enrichmentStatus: security.gatewayLogId ? "pending" : "unavailable",
          createdAt: now,
        },
      ],
      expectedExpiresAt,
    );
  }

  async recordRejectedExchange(
    conversationId: string,
    userContent: string,
    assistantContent: string,
    outcome: "blocked" | "failed",
    enforcement: TranscriptEnforcement | null,
    security: TranscriptSecurity,
    expectedExpiresAt: number,
  ): Promise<void> {
    const now = Date.now();
    await this.appendTranscript(
      conversationId,
      [
        {
          id: crypto.randomUUID(),
          role: "user",
          content: userContent,
          outcome,
          ...(enforcement ? { enforcement } : {}),
          ...(security.gatewayLogId ? { gatewayLogId: security.gatewayLogId } : {}),
          enrichmentStatus: security.gatewayLogId ? "pending" : "complete",
          ...(enforcement === "guardrails" ? { guardrailAction: "BLOCK" as const } : {}),
          ...(security.dlpAction ? { dlpAction: security.dlpAction } : {}),
          ...(security.dlpMatches.length ? { dlpMatches: security.dlpMatches } : {}),
          createdAt: now,
        },
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: assistantContent,
          outcome: "allowed",
          enrichmentStatus: "complete",
          createdAt: now,
        },
      ],
      expectedExpiresAt,
    );
  }

  async getTranscript(): Promise<LiveTranscript | null> {
    const expiresAt = await this.ctx.storage.get<number>("expiresAt");
    if (!expiresAt || expiresAt <= Date.now()) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return null;
    }
    return {
      entries: (await this.ctx.storage.get<TranscriptEntry[]>("transcript")) ?? [],
      expiresAt,
    };
  }

  async applySummary(token: string, summary: string): Promise<void> {
    const pendingToken = await this.ctx.storage.get<string>("summaryPendingToken");
    const pendingCount = (await this.ctx.storage.get<number>("summaryPendingCount")) ?? 0;
    const expiresAt = await this.ctx.storage.get<number>("expiresAt");
    if (pendingToken !== token || !expiresAt || expiresAt <= Date.now()) return;

    const history = (await this.ctx.storage.get<ChatMessage[]>("messages")) ?? [];
    await this.ctx.storage.put({ summary, messages: history.slice(pendingCount) });
    await this.ctx.storage.delete(["summaryPendingToken", "summaryPendingCount"]);
  }

  async cancelSummary(token: string): Promise<void> {
    if ((await this.ctx.storage.get<string>("summaryPendingToken")) !== token) return;
    await this.ctx.storage.delete(["summaryPendingToken", "summaryPendingCount"]);
  }

  async alarm(): Promise<void> {
    const expiresAt = await this.ctx.storage.get<number>("expiresAt");
    if (expiresAt && expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(expiresAt);
      return;
    }
    if (!(await this.flushPendingPersistence())) {
      await this.ctx.storage.setAlarm(Date.now() + 5 * 60 * 1000);
      return;
    }
    await this.ctx.storage.deleteAll();
  }

  async reset(): Promise<void> {
    await this.flushPendingPersistence();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
}
