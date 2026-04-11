-- Migration 024: Telegram conversation turns + agent action outcomes

-- Telegram conversation turns: enables multi-turn history per chat
CREATE TABLE IF NOT EXISTS telegram_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  intent_type TEXT,
  action_taken TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_telegram_turns_chat ON telegram_turns(chat_id, created_at DESC);

-- Agent action outcomes: tracks whether agent actions were helpful
CREATE TABLE IF NOT EXISTS agent_action_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type TEXT NOT NULL,
  inferred_value TEXT NOT NULL,
  actual_outcome TEXT,
  was_corrected INTEGER DEFAULT 0,
  correction_text TEXT,
  helpful INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_agent_outcomes_type ON agent_action_outcomes(action_type, created_at DESC);
