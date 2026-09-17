import type { TranscriptEntry } from "./session";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface StoredConversation {
  id: string;
  startedAt: number;
  lastActivityAt: number;
  messageCount: number;
  flaggedCount: number;
  blockedCount: number;
  guardedCount: number;
  failedCount: number;
}

export interface GuardrailResult {
  code: string;
  action: "FLAG" | "BLOCK";
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  outcome: "allowed" | "guarded" | "blocked" | "failed";
  enforcement: "application" | "guardrails" | "dlp" | null;
  gatewayLogId: string | null;
  enrichmentStatus: "pending" | "complete" | "unavailable";
  guardrailAction: "FLAG" | "BLOCK" | null;
  guardrailCategories: string[];
  guardrailResults: GuardrailResult[];
  dlpAction: "FLAG" | "BLOCK" | null;
  dlpMatches: string[];
  displayedAt: number;
}

interface ConversationRow {
  id: string;
  started_at: number;
  last_activity_at: number;
  message_count: number;
  flagged_count: number;
  blocked_count: number;
  guarded_count: number;
  failed_count: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  outcome: "allowed" | "guarded" | "blocked" | "failed";
  enforcement: "application" | "guardrails" | "dlp" | null;
  gateway_log_id: string | null;
  enrichment_status: "pending" | "complete" | "unavailable";
  guardrail_action: "FLAG" | "BLOCK" | null;
  guardrail_categories_json: string | null;
  guardrail_results_json: string | null;
  dlp_action: "FLAG" | "BLOCK" | null;
  dlp_matches_json: string | null;
  displayed_at: number;
}

function parseArray(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseGuardrailResults(value: string | null): GuardrailResult[] {
  return parseArray(value).filter(
    (result): result is GuardrailResult =>
      Boolean(
        result &&
          typeof result === "object" &&
          "code" in result &&
          typeof result.code === "string" &&
          "action" in result &&
          (result.action === "FLAG" || result.action === "BLOCK"),
      ),
  );
}

function mapConversation(row: ConversationRow): StoredConversation {
  return {
    id: row.id,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
    messageCount: row.message_count,
    flaggedCount: row.flagged_count,
    blockedCount: row.blocked_count,
    guardedCount: row.guarded_count,
    failedCount: row.failed_count,
  };
}

function mapMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    role: row.role,
    content: row.content,
    outcome: row.outcome,
    enforcement: row.enforcement,
    gatewayLogId: row.gateway_log_id,
    enrichmentStatus: row.enrichment_status,
    guardrailAction: row.guardrail_action,
    guardrailCategories: parseArray(row.guardrail_categories_json).filter((value): value is string => typeof value === "string"),
    guardrailResults: parseGuardrailResults(row.guardrail_results_json),
    dlpAction: row.dlp_action,
    dlpMatches: parseArray(row.dlp_matches_json).filter((value): value is string => typeof value === "string"),
    displayedAt: row.displayed_at,
  };
}

function refreshConversationCounts(db: D1Database, conversationId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE conversations SET
        message_count = (SELECT COUNT(*) FROM conversation_messages WHERE conversation_id = ?1),
        flagged_count = (SELECT COUNT(*) FROM conversation_messages WHERE conversation_id = ?1 AND (guardrail_action = 'FLAG' OR dlp_action = 'FLAG')),
        blocked_count = (SELECT COUNT(*) FROM conversation_messages WHERE conversation_id = ?1 AND outcome = 'blocked' AND role = 'user'),
        guarded_count = (SELECT COUNT(*) FROM conversation_messages WHERE conversation_id = ?1 AND outcome = 'guarded' AND role = 'user'),
        failed_count = (SELECT COUNT(*) FROM conversation_messages WHERE conversation_id = ?1 AND outcome = 'failed' AND role = 'user')
      WHERE id = ?1`,
    )
    .bind(conversationId);
}

export async function persistTranscriptEntries(
  db: D1Database,
  conversationId: string,
  entries: TranscriptEntry[],
): Promise<void> {
  if (!entries.length) return;
  for (let offset = 0; offset < entries.length; offset += 40) {
    const batch = entries.slice(offset, offset + 40);
    const startedAt = Math.min(...batch.map((entry) => entry.createdAt));
    const lastActivityAt = Math.max(...batch.map((entry) => entry.createdAt));
    const statements = [
      db
        .prepare(
          `INSERT INTO conversations (id, started_at, last_activity_at)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(id) DO UPDATE SET last_activity_at = MAX(last_activity_at, excluded.last_activity_at)`,
        )
        .bind(conversationId, startedAt, lastActivityAt),
      ...batch.map((entry) =>
        db
          .prepare(
            `INSERT OR IGNORE INTO conversation_messages (
              id, conversation_id, sequence, role, content, outcome, enforcement,
              gateway_log_id, enrichment_status, guardrail_action,
              guardrail_categories_json, guardrail_results_json, dlp_action, dlp_matches_json, displayed_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
          )
          .bind(
            entry.id,
            conversationId,
            entry.sequence,
            entry.role,
            entry.content,
            entry.outcome,
            entry.enforcement ?? null,
            entry.gatewayLogId ?? null,
            entry.enrichmentStatus,
            entry.guardrailAction ?? null,
            entry.guardrailCategories?.length ? JSON.stringify(entry.guardrailCategories) : null,
            entry.guardrailResults?.length ? JSON.stringify(entry.guardrailResults) : null,
            entry.dlpAction ?? null,
            entry.dlpMatches?.length ? JSON.stringify(entry.dlpMatches) : null,
            entry.createdAt,
          ),
      ),
      refreshConversationCounts(db, conversationId),
    ];
    await db.batch(statements);
  }
}

export async function enrichTranscriptMessages(
  db: D1Database,
  conversationId: string,
  gatewayLogId: string,
  promptGuardrails: Record<string, "FLAG" | "BLOCK">,
  responseGuardrails: Record<string, "FLAG" | "BLOCK">,
  dlpAction: "FLAG" | "BLOCK" | null,
  dlpMatches: string[],
): Promise<void> {
  const promptEntries = Object.entries(promptGuardrails);
  const responseEntries = Object.entries(responseGuardrails);
  const promptAction = promptEntries.some(([, action]) => action === "BLOCK") ? "BLOCK" : promptEntries.length ? "FLAG" : null;
  const responseAction = responseEntries.some(([, action]) => action === "BLOCK") ? "BLOCK" : responseEntries.length ? "FLAG" : null;
  await db.batch([
    db
      .prepare(
        `UPDATE conversation_messages SET enrichment_status = 'complete', guardrail_action = ?1,
         guardrail_categories_json = ?2, guardrail_results_json = ?3, dlp_action = COALESCE(dlp_action, ?4),
         dlp_matches_json = CASE WHEN dlp_matches_json IS NULL THEN ?5 ELSE dlp_matches_json END
         WHERE conversation_id = ?6 AND gateway_log_id = ?7 AND role = 'user'`,
      )
      .bind(
        promptAction,
        promptEntries.length ? JSON.stringify(promptEntries.map(([code]) => code)) : null,
        promptEntries.length ? JSON.stringify(promptEntries.map(([code, action]) => ({ code, action }))) : null,
        dlpAction,
        dlpMatches.length ? JSON.stringify(dlpMatches) : null,
        conversationId,
        gatewayLogId,
      ),
    db
      .prepare(
        `UPDATE conversation_messages SET enrichment_status = 'complete', guardrail_action = ?1,
         guardrail_categories_json = ?2, guardrail_results_json = ?3
         WHERE conversation_id = ?4 AND gateway_log_id = ?5 AND role = 'assistant'`,
      )
      .bind(
        responseAction,
        responseEntries.length ? JSON.stringify(responseEntries.map(([code]) => code)) : null,
        responseEntries.length ? JSON.stringify(responseEntries.map(([code, action]) => ({ code, action }))) : null,
        conversationId,
        gatewayLogId,
      ),
    refreshConversationCounts(db, conversationId),
  ]);
}

export async function markEnrichmentUnavailable(db: D1Database, conversationId: string, gatewayLogId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE conversation_messages SET enrichment_status = 'unavailable'
       WHERE conversation_id = ?1 AND gateway_log_id = ?2 AND enrichment_status = 'pending'`,
    )
    .bind(conversationId, gatewayLogId)
    .run();
}

export async function listConversations(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<{ conversations: StoredConversation[]; total: number }> {
  const results = await db.batch([
    db.prepare(`SELECT * FROM conversations ORDER BY last_activity_at DESC LIMIT ?1 OFFSET ?2`).bind(limit, offset),
    db.prepare(`SELECT COUNT(*) AS total FROM conversations`),
  ]);
  const rows = results[0]?.results ?? [];
  const count = results[1]?.results ?? [];
  const total = Number((count[0] as { total?: number } | undefined)?.total ?? 0);
  return { conversations: (rows as unknown as ConversationRow[]).map(mapConversation), total };
}

export async function getConversation(
  db: D1Database,
  conversationId: string,
): Promise<{ conversation: StoredConversation; messages: StoredMessage[] } | null> {
  const results = await db.batch([
    db.prepare(`SELECT * FROM conversations WHERE id = ?1`).bind(conversationId),
    db.prepare(`SELECT * FROM conversation_messages WHERE conversation_id = ?1 ORDER BY sequence ASC`).bind(conversationId),
  ]);
  const conversation = (results[0]?.results?.[0] as unknown as ConversationRow | undefined) ?? null;
  if (!conversation) return null;
  return {
    conversation: mapConversation(conversation),
    messages: ((results[1]?.results ?? []) as unknown as MessageRow[]).map(mapMessage),
  };
}

export async function purgeExpiredConversations(db: D1Database, now = Date.now()): Promise<number> {
  const cutoff = now - RETENTION_MS;
  const result = await db.prepare(`DELETE FROM conversations WHERE last_activity_at < ?1`).bind(cutoff).run();
  return result.meta.changes ?? 0;
}
