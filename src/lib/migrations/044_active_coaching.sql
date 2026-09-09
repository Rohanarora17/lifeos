-- Active coaching: one coordinated engagement state, recovery episodes, and
-- auditable intervention outcomes shared by every proactive surface.

CREATE TABLE IF NOT EXISTS coaching_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  episode_id TEXT,
  commitment_id TEXT,
  dedupe_key TEXT UNIQUE,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_coaching_events_type_time
  ON coaching_events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_coaching_events_episode
  ON coaching_events(episode_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS coaching_episodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'recovery',
  status TEXT NOT NULL DEFAULT 'open'
    CHECK(status IN ('open', 'reconnecting', 'resolved', 'paused')),
  trigger_reason TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  first_response_at TEXT,
  accepted_at TEXT,
  resolved_at TEXT,
  resolution TEXT,
  blocker_kind TEXT,
  blocker_text TEXT,
  next_action_text TEXT,
  restart_minutes INTEGER NOT NULL DEFAULT 10,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coaching_episodes_status
  ON coaching_episodes(status, opened_at DESC);

CREATE TABLE IF NOT EXISTS coaching_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id TEXT REFERENCES coaching_episodes(id) ON DELETE SET NULL,
  policy_version TEXT NOT NULL,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK(status IN ('proposed', 'suppressed', 'sent', 'accepted', 'rejected', 'completed', 'failed')),
  channel TEXT,
  message TEXT,
  reason TEXT NOT NULL,
  expected_outcome TEXT,
  actual_outcome TEXT,
  dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coaching_decisions_episode
  ON coaching_decisions(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coaching_decisions_action
  ON coaching_decisions(action_type, created_at DESC);
