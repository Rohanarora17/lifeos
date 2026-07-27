-- Guardian system tables, knowledge graph, and session infrastructure
-- These were previously created inline in db.ts; moved here for proper migration tracking.

-- Knowledge Graph
CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL DEFAULT 'concept' CHECK(node_type IN ('concept', 'skill', 'topic')),
  mastery REAL NOT NULL DEFAULT 0.0 CHECK(mastery >= 0.0 AND mastery <= 1.0),
  bloom_level INTEGER DEFAULT 1,
  decay_rate REAL DEFAULT 0.02,
  total_study_minutes INTEGER DEFAULT 0,
  last_studied TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS knowledge_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_node_id INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  to_node_id INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL DEFAULT 'prerequisite' CHECK(edge_type IN ('prerequisite', 'related')),
  weight REAL NOT NULL DEFAULT 0.5 CHECK(weight > 0.0 AND weight <= 1.0),
  UNIQUE(from_node_id, to_node_id)
);

CREATE TABLE IF NOT EXISTS node_task_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  study_session_id INTEGER,
  contribution REAL NOT NULL DEFAULT 0.4 CHECK(contribution > 0.0 AND contribution <= 1.0)
);

-- Session infrastructure (legacy agent loop tables)
CREATE TABLE IF NOT EXISTS session_ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tick INTEGER NOT NULL,
  focus_score INTEGER,
  url TEXT,
  url_classification TEXT,
  action_taken TEXT,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS jarvis_explanations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  data_points TEXT,
  confidence REAL,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

-- Guardian runtime tables
CREATE TABLE IF NOT EXISTS guardian_override_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  reason TEXT NOT NULL,
  requested_minutes INTEGER,
  approved INTEGER NOT NULL DEFAULT 0,
  decision_reason TEXT NOT NULL,
  explainability TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS guardian_artifact_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_type TEXT NOT NULL,
  version TEXT NOT NULL,
  content TEXT NOT NULL,
  guardian_eval_score REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  promoted_at TEXT DEFAULT NULL,
  notes TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS guardian_eval_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suite_name TEXT NOT NULL,
  case_name TEXT NOT NULL,
  scenario_type TEXT NOT NULL,
  input_payload TEXT NOT NULL,
  expected_outcome TEXT DEFAULT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_eval_cases_suite_name ON guardian_eval_cases(suite_name, case_name);

CREATE TABLE IF NOT EXISTS guardian_eval_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_version_id INTEGER REFERENCES guardian_artifact_versions(id) ON DELETE SET NULL,
  suite_name TEXT NOT NULL,
  wall_clock_budget_seconds INTEGER NOT NULL,
  primary_metric TEXT NOT NULL,
  guardian_eval_score REAL NOT NULL DEFAULT 0,
  hard_failures INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  summary TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now', 'localtime')),
  completed_at TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS guardian_promotions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_version_id INTEGER NOT NULL REFERENCES guardian_artifact_versions(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS guardian_canary_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guardian_eval_score REAL NOT NULL,
  status TEXT NOT NULL,
  notes TEXT DEFAULT NULL,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS guardian_session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  target_title TEXT NOT NULL,
  goal_title TEXT DEFAULT NULL,
  concept_node_name TEXT DEFAULT NULL,
  mood TEXT DEFAULT NULL,
  duration_minutes INTEGER NOT NULL,
  elapsed_minutes INTEGER NOT NULL,
  average_focus_score REAL NOT NULL,
  final_focus_score REAL NOT NULL,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  override_count INTEGER NOT NULL DEFAULT 0,
  distraction_events INTEGER NOT NULL DEFAULT 0,
  productive_events INTEGER NOT NULL DEFAULT 0,
  neutral_events INTEGER NOT NULL DEFAULT 0,
  dominant_distraction_domain TEXT DEFAULT NULL,
  completed_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS guardian_semantic_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE,
  coaching_style TEXT NOT NULL DEFAULT 'balanced',
  typical_energy_band TEXT NOT NULL DEFAULT 'medium',
  best_start_hour INTEGER DEFAULT NULL,
  recurring_distraction_domains TEXT NOT NULL DEFAULT '[]',
  strong_topics TEXT NOT NULL DEFAULT '[]',
  friction_topics TEXT NOT NULL DEFAULT '[]',
  commitment_follow_through_rate REAL DEFAULT NULL,
  updated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS guardian_session_reflections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL UNIQUE,
  reflection_text TEXT NOT NULL,
  focus_quality TEXT NOT NULL DEFAULT 'neutral',
  generated_at TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS soft_watch_commitments (
  id TEXT PRIMARY KEY,
  target_title TEXT NOT NULL,
  goal_id INTEGER REFERENCES goals(id) ON DELETE SET NULL,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  intended_start_at INTEGER NOT NULL,
  planned_minutes INTEGER NOT NULL DEFAULT 60,
  source TEXT NOT NULL DEFAULT 'voice',
  reminder_sent_at INTEGER DEFAULT NULL,
  check_in_sent_at INTEGER DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  locked_in_session_id TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL
);
