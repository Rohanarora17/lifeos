import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'lifeos.db');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db: Database.Database) {
  // Create migrations tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT current_timestamp
    )
  `);

  const migrationsDir = path.join(process.cwd(), 'src', 'lib', 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    console.log('[DB] Migrations directory not found at', migrationsDir);
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort(); // ensures 001_, 002_ ordering

  for (const file of files) {
    const isApplied = db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file);
    if (!isApplied) {
      console.log(`[DB] Applying migration: ${file}`);
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      db.transaction(() => {
        db.exec(sql);
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      })();
    }
  }

  // Migrations
  try { db.prepare('ALTER TABLE habits ADD COLUMN goal_metric TEXT DEFAULT "boolean" CHECK(goal_metric IN ("boolean", "time"))').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE habits ADD COLUMN goal_target INTEGER DEFAULT 1').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE habit_checkins ADD COLUMN value INTEGER DEFAULT 1').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE behavior_insights ADD COLUMN feedback TEXT DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE behavioral_memory ADD COLUMN superseded INTEGER DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE behavioral_memory ADD COLUMN source TEXT DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE alerts ADD COLUMN title TEXT DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE alerts ADD COLUMN priority TEXT DEFAULT NULL').run(); } catch (e) { }
  // Backfill focus_sessions columns missing from the old 003 schema (014 migration no-ops when table already exists)
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN goal_id INTEGER DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN goal_title TEXT DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN task_id INTEGER DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN task_title TEXT DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN actual_duration_seconds INTEGER DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN productive_seconds INTEGER DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN distraction_seconds INTEGER DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN neutral_seconds INTEGER DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN tabs_opened INTEGER DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN tabs_blocked INTEGER DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN tabs_overridden INTEGER DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN top_domains TEXT DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN ai_report TEXT DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN status TEXT DEFAULT "completed"').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN ended_at TEXT DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN duration_minutes INTEGER DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE focus_sessions ADD COLUMN started_at TEXT DEFAULT NULL').run(); } catch (e) { }
  // Backfill started_at from old start_time column if it exists
  try { db.prepare("UPDATE focus_sessions SET started_at = start_time WHERE started_at IS NULL AND start_time IS NOT NULL").run(); } catch (e) { }

  // === Knowledge Graph Tables ===
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_nodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
        node_type TEXT NOT NULL DEFAULT 'concept' CHECK(node_type IN ('concept', 'skill', 'topic')),
        mastery REAL NOT NULL DEFAULT 0.0 CHECK(mastery >= 0.0 AND mastery <= 1.0),
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
        study_session_id INTEGER REFERENCES focus_sessions(id) ON DELETE SET NULL,
        contribution REAL NOT NULL DEFAULT 0.4 CHECK(contribution > 0.0 AND contribution <= 1.0)
      );
    `);
  } catch (e) { /* tables may already exist */ }

  try { db.prepare('ALTER TABLE knowledge_nodes ADD COLUMN bloom_level INTEGER DEFAULT 1').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE knowledge_nodes ADD COLUMN decay_rate REAL DEFAULT 0.02').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE knowledge_nodes ADD COLUMN total_study_minutes INTEGER DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE knowledge_nodes ADD COLUMN last_studied TEXT DEFAULT NULL').run(); } catch (e) { }

  try {
    db.exec(`
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
        updated_at TEXT DEFAULT (datetime('now', 'localtime'))
      );
    `);
  } catch (e) { /* tables may already exist */ }

  // Insert default settings if not present
  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );
  const defaults: Record<string, string> = {
    gemini_api_key: '',
    github_pat: '',
    github_username: '',
    calendar_ics_url: '',
    nudge_threshold_minutes: '15',
    daily_summary_time: '23:00',
    morning_brief_time: '08:00',
    xp_per_task: '50',
    xp_per_habit: '20',
    xp_per_productive_hour: '30',
    xp_per_commit: '10',
    level_xp_base: '500',
    distraction_domains: '[]',
    productive_domains: '[]',
  };

  for (const [key, value] of Object.entries(defaults)) {
    insertSetting.run(key, value);
  }
}

export function getSetting(key: string): string {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

export default getDb;
