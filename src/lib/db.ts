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
  db.exec(`
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      domain TEXT NOT NULL,
      title TEXT DEFAULT '',
      category TEXT DEFAULT 'neutral',
      subcategory TEXT DEFAULT 'other',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_seconds INTEGER DEFAULT 0,
      ai_classification TEXT,
      youtube_video_id TEXT,
      youtube_channel TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_activities_started ON activities(started_at);
    CREATE INDEX IF NOT EXISTS idx_activities_domain ON activities(domain);
    CREATE INDEX IF NOT EXISTS idx_activities_category ON activities(category);

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'backlog' CHECK(status IN ('backlog','next','this_week','today','doing','done')),
      due_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      position INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

    CREATE TABLE IF NOT EXISTS habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT DEFAULT '✅',
      frequency TEXT DEFAULT 'daily' CHECK(frequency IN ('daily','weekly')),
      created_at TEXT DEFAULT (datetime('now')),
      archived INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS habit_checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      habit_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      completed INTEGER DEFAULT 1,
      FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE,
      UNIQUE(habit_id, date)
    );

    CREATE TABLE IF NOT EXISTS daily_scores (
      date TEXT PRIMARY KEY,
      xp_earned INTEGER DEFAULT 0,
      productive_minutes INTEGER DEFAULT 0,
      distraction_minutes INTEGER DEFAULT 0,
      neutral_minutes INTEGER DEFAULT 0,
      tasks_completed INTEGER DEFAULT 0,
      habits_completed INTEGER DEFAULT 0,
      total_habits INTEGER DEFAULT 0,
      ai_summary TEXT,
      ai_morning_brief TEXT,
      level INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      location TEXT DEFAULT '',
      synced_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS github_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('commit','pr','review','issue')),
      repo TEXT NOT NULL,
      message TEXT DEFAULT '',
      url TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      synced_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_github_created ON github_activity(created_at);

    CREATE TABLE IF NOT EXISTS nudge_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message TEXT NOT NULL,
      domain TEXT,
      duration_minutes INTEGER,
      acknowledged INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Tab switch events for focus & entropy analysis
    CREATE TABLE IF NOT EXISTS tab_switches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_domain TEXT,
      to_domain TEXT,
      from_category TEXT,
      to_category TEXT,
      switched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tab_switches_at ON tab_switches(switched_at);

    -- Computed focus/deep work sessions
    CREATE TABLE IF NOT EXISTS focus_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL,
      focus_type TEXT DEFAULT 'shallow' CHECK(focus_type IN ('deep','moderate','shallow','fragmented')),
      primary_domain TEXT,
      primary_category TEXT,
      tab_switches INTEGER DEFAULT 0,
      context_switches INTEGER DEFAULT 0,
      flow_state_detected INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_focus_date ON focus_sessions(session_date);

    -- User goals for alignment scoring
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      type TEXT DEFAULT 'daily' CHECK(type IN ('daily','weekly','monthly')),
      metric TEXT NOT NULL,
      target_value REAL NOT NULL,
      unit TEXT DEFAULT 'minutes',
      category TEXT DEFAULT 'productivity',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Behavioral profile KV store
    CREATE TABLE IF NOT EXISTS behavior_profile (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      last_updated TEXT DEFAULT (datetime('now')),
      update_count INTEGER DEFAULT 1
    );

    -- Analysis snapshots
    CREATE TABLE IF NOT EXISTS behavior_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_date ON behavior_snapshots(snapshot_date);

    -- AI-generated insights
    CREATE TABLE IF NOT EXISTS behavior_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      insight TEXT NOT NULL,
      actionable_tip TEXT,
      severity TEXT DEFAULT 'info',
      acknowledged INTEGER DEFAULT 0,
      feedback TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_insights_category ON behavior_insights(category);

    -- Progressive behavioral memory (accumulates, never overwritten)
    CREATE TABLE IF NOT EXISTS behavioral_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_type TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT DEFAULT 'deep_analysis',
      confidence REAL DEFAULT 0.5,
      reinforcement_count INTEGER DEFAULT 1,
      first_observed TEXT DEFAULT (datetime('now')),
      last_reinforced TEXT DEFAULT (datetime('now')),
      superseded INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_memory_type ON behavioral_memory(memory_type);
    CREATE INDEX IF NOT EXISTS idx_memory_active ON behavioral_memory(superseded);
  `);

  // Insert default settings if not present
  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );
  const defaults: Record<string, string> = {
    gemini_api_key: '',
    github_pat: '',
    nudge_threshold_minutes: '15',
    daily_summary_time: '23:00',
    morning_brief_time: '08:00',
    xp_per_task: '50',
    xp_per_habit: '20',
    xp_per_productive_hour: '30',
    xp_per_commit: '10',
    level_xp_base: '500',
    distraction_domains: JSON.stringify([
      'twitter.com', 'x.com', 'instagram.com', 'facebook.com',
      'reddit.com', 'tiktok.com', 'netflix.com', 'twitch.tv'
    ]),
    productive_domains: JSON.stringify([
      'github.com', 'stackoverflow.com', 'developer.mozilla.org',
      'docs.google.com', 'notion.so', 'figma.com', 'vercel.com',
      'linear.app', 'arxiv.org', 'scholar.google.com'
    ]),
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
