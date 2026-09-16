PRAGMA foreign_keys = ON;

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  flagged_count INTEGER NOT NULL DEFAULT 0,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  guarded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE conversation_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'guarded', 'blocked', 'failed')),
  enforcement TEXT CHECK (enforcement IN ('application', 'guardrails', 'dlp')),
  gateway_log_id TEXT,
  enrichment_status TEXT NOT NULL DEFAULT 'pending' CHECK (enrichment_status IN ('pending', 'complete', 'unavailable')),
  guardrail_action TEXT CHECK (guardrail_action IN ('FLAG', 'BLOCK')),
  guardrail_categories_json TEXT,
  dlp_action TEXT CHECK (dlp_action IN ('FLAG', 'BLOCK')),
  dlp_matches_json TEXT,
  displayed_at INTEGER NOT NULL,
  UNIQUE (conversation_id, sequence),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX idx_conversations_last_activity ON conversations(last_activity_at DESC);
CREATE INDEX idx_messages_conversation_sequence ON conversation_messages(conversation_id, sequence);
CREATE INDEX idx_messages_gateway_log ON conversation_messages(gateway_log_id);
CREATE INDEX idx_messages_outcome ON conversation_messages(outcome);
