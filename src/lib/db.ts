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
