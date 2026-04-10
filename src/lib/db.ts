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

  // Column backfills for tables that pre-date the migration system.
  // SQLite has no ALTER TABLE ... ADD COLUMN IF NOT EXISTS, so these are try-caught.
  // New installs get all columns from migration 015; these only fire on upgraded DBs.
  try { db.prepare('ALTER TABLE habits ADD COLUMN goal_metric TEXT DEFAULT "boolean" CHECK(goal_metric IN ("boolean", "time"))').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE habits ADD COLUMN goal_target INTEGER DEFAULT 1').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE habit_checkins ADD COLUMN value INTEGER DEFAULT 1').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE behavior_insights ADD COLUMN feedback TEXT DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE behavioral_memory ADD COLUMN superseded INTEGER DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE behavioral_memory ADD COLUMN source TEXT DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE alerts ADD COLUMN title TEXT DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE alerts ADD COLUMN priority TEXT DEFAULT NULL').run(); } catch (e) { }
  // knowledge_nodes: backfill columns added after initial inline creation
  try { db.prepare('ALTER TABLE knowledge_nodes ADD COLUMN bloom_level INTEGER DEFAULT 1').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE knowledge_nodes ADD COLUMN decay_rate REAL DEFAULT 0.02').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE knowledge_nodes ADD COLUMN total_study_minutes INTEGER DEFAULT 0').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE knowledge_nodes ADD COLUMN last_studied TEXT DEFAULT NULL').run(); } catch (e) { }
  // guardian_semantic_profiles: commitment_follow_through_rate added after initial creation
  try { db.prepare('ALTER TABLE guardian_semantic_profiles ADD COLUMN commitment_follow_through_rate REAL DEFAULT NULL').run(); } catch (e) { }
  // mem_facts: embedding vector (JSON float array) for semantic search at scale
  try { db.prepare('ALTER TABLE mem_facts ADD COLUMN embedding TEXT DEFAULT NULL').run(); } catch (e) { }
  // activities: AI confidence level + user review flag (migration 021)
  try { db.prepare("ALTER TABLE activities ADD COLUMN classification_confidence TEXT DEFAULT NULL").run(); } catch (e) { }
  try { db.prepare("ALTER TABLE activities ADD COLUMN classification_reviewed INTEGER DEFAULT 0").run(); } catch (e) { }

  // ─── P0.2: tasks — energy routing + friction detection ────────────────────
  try { db.prepare("ALTER TABLE tasks ADD COLUMN energy_required TEXT DEFAULT 'medium'").run(); } catch (e) { }
  try { db.prepare("ALTER TABLE tasks ADD COLUMN complexity TEXT DEFAULT 'familiar'").run(); } catch (e) { }
  try { db.prepare('ALTER TABLE tasks ADD COLUMN estimated_minutes INTEGER DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE tasks ADD COLUMN blocked_since TEXT DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE tasks ADD COLUMN subtask_of INTEGER REFERENCES tasks(id)').run(); } catch (e) { }

  // ─── P0.3: goals — type system + velocity tracking ────────────────────────
  try { db.prepare("ALTER TABLE goals ADD COLUMN goal_type TEXT DEFAULT 'milestone'").run(); } catch (e) { }
  try { db.prepare('ALTER TABLE goals ADD COLUMN target_value REAL DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE goals ADD COLUMN progress_value REAL DEFAULT 0').run(); } catch (e) { }
  try { db.prepare("ALTER TABLE goals ADD COLUMN health_status TEXT DEFAULT 'on_track'").run(); } catch (e) { }
  try { db.prepare('ALTER TABLE goals ADD COLUMN velocity_needed REAL DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE goals ADD COLUMN actual_velocity REAL DEFAULT NULL').run(); } catch (e) { }

  // ─── P0.4a: habit_checkins — source tagging for deduplication ─────────────
  try { db.prepare("ALTER TABLE habit_checkins ADD COLUMN source TEXT DEFAULT 'manual'").run(); } catch (e) { }
  try { db.prepare('ALTER TABLE habit_checkins ADD COLUMN session_id TEXT DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE habit_checkins ADD COLUMN window_start TEXT DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE habit_checkins ADD COLUMN window_end TEXT DEFAULT NULL').run(); } catch (e) { }

  // ─── P0.4b: guardian_semantic_profiles — per-user calibration weights ──────
  try { db.prepare('ALTER TABLE guardian_semantic_profiles ADD COLUMN energy_weight_standup REAL DEFAULT 0.30').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE guardian_semantic_profiles ADD COLUMN energy_weight_time_of_day REAL DEFAULT 0.25').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE guardian_semantic_profiles ADD COLUMN energy_weight_focus_quality REAL DEFAULT 0.25').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE guardian_semantic_profiles ADD COLUMN energy_weight_circadian REAL DEFAULT 0.20').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE guardian_semantic_profiles ADD COLUMN focus_weight_continuity REAL DEFAULT 0.35').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE guardian_semantic_profiles ADD COLUMN focus_weight_tab_switches REAL DEFAULT 0.25').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE guardian_semantic_profiles ADD COLUMN focus_weight_dwell REAL DEFAULT 0.20').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE guardian_semantic_profiles ADD COLUMN focus_weight_distraction_revisit REAL DEFAULT 0.15').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE guardian_semantic_profiles ADD COLUMN focus_weight_idle REAL DEFAULT 0.05').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE guardian_semantic_profiles ADD COLUMN calibration_accuracy REAL DEFAULT NULL').run(); } catch (e) { }
  try { db.prepare('ALTER TABLE guardian_semantic_profiles ADD COLUMN calibration_sessions_count INTEGER DEFAULT 0').run(); } catch (e) { }

  // voice_turns: persistent conversation memory for the voice agent
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'model')),
      text TEXT NOT NULL,
      action TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_voice_turns_session ON voice_turns(session_key, created_at DESC);
  `);

  // user_intelligence_profile: versioned UIL snapshots
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_intelligence_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      synthesized_at TEXT DEFAULT (datetime('now')),
      trigger TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_uil_version ON user_intelligence_profile(version DESC);
  `);

  // ─── 4-TIER MEMORY LAYER ───────────────────────────────────────────────────
  db.exec(`
    -- EPISODIC MEMORY: structured episode log
    CREATE TABLE IF NOT EXISTS mem_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL CHECK(source IN ('guardian','voice','chat','browse','manual')),
      summary TEXT NOT NULL,
      raw_context TEXT,
      importance REAL DEFAULT 0.5,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mem_ep_source ON mem_episodes(source, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mem_ep_importance ON mem_episodes(importance DESC);

    -- SEMANTIC MEMORY: distilled facts (Mem0-style)
    CREATE TABLE IF NOT EXISTS mem_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK(category IN (
        'preference','pattern','habit','identity','goal','mood','constraint'
      )),
      topic TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL DEFAULT 0.7,
      importance REAL DEFAULT 0.5,
      status TEXT DEFAULT 'unverified' CHECK(status IN ('active','unverified','superseded')),
      half_life_days INTEGER DEFAULT 14,
      source TEXT DEFAULT 'inferred',
      source_episode_ids TEXT DEFAULT '[]',
      confirmed_count INTEGER DEFAULT 1,
      last_confirmed TEXT DEFAULT (datetime('now')),
      last_accessed TEXT DEFAULT (datetime('now')),
      access_count INTEGER DEFAULT 0,
      superseded_by INTEGER REFERENCES mem_facts(id),
      embedding TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mem_facts_status ON mem_facts(status, importance DESC);
    CREATE INDEX IF NOT EXISTS idx_mem_facts_category ON mem_facts(category);

    -- PROCEDURAL MEMORY: coaching macros with versioning
    CREATE TABLE IF NOT EXISTS mem_procedures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      trigger_pattern TEXT NOT NULL,
      action_template TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','active','archived')),
      version INTEGER DEFAULT 1,
      superseded_by INTEGER REFERENCES mem_procedures(id),
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      last_used TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- WORKING MEMORY: session tick snapshots for audit trail
    CREATE TABLE IF NOT EXISTS mem_working (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      cognitive_state TEXT DEFAULT 'IDLE',
      focus_score REAL,
      cognitive_load REAL,
      active_facts TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mem_working_session ON mem_working(session_id, created_at DESC);
  `);

  // ─── P0.4c: new tables for unified intelligence architecture ──────────────
  db.exec(`
    -- Energy composite readings (per-session + mid-session drift)
    CREATE TABLE IF NOT EXISTS energy_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT DEFAULT (datetime('now', 'localtime')),
      standup_mood INTEGER,
      time_of_day_prior REAL,
      recent_focus_quality REAL,
      circadian_prior REAL,
      composite_score REAL,
      session_id TEXT DEFAULT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_energy_readings_session ON energy_readings(session_id);
    CREATE INDEX IF NOT EXISTS idx_energy_readings_time ON energy_readings(timestamp DESC);

    -- Time credited to goals from guardian sessions
    CREATE TABLE IF NOT EXISTS goal_time_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      minutes REAL NOT NULL,
      logged_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_goal_time_logs_goal ON goal_time_logs(goal_id);

    -- Post-session completion review queue
    CREATE TABLE IF NOT EXISTS session_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      task_id INTEGER REFERENCES tasks(id),
      status TEXT DEFAULT 'pending',
      completion_note TEXT DEFAULT NULL,
      blocker_note TEXT DEFAULT NULL,
      actioned_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_session_completions_status ON session_completions(status, created_at DESC);

    -- Post-session free-text feedback + calibration gap analysis
    CREATE TABLE IF NOT EXISTS session_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      system_energy_composite REAL,
      system_focus_trajectory TEXT,
      system_distraction_events TEXT,
      system_tab_switch_pattern TEXT,
      system_idle_periods TEXT,
      system_intervention_count INTEGER,
      system_override_count INTEGER,
      gap_analysis TEXT,
      prediction_error_energy REAL,
      prediction_error_focus REAL,
      session_length_fit TEXT,
      self_awareness_score REAL,
      extracted_facts TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      processed_at TEXT DEFAULT NULL
    );

    -- Audit trail of every weight adjustment from calibration
    CREATE TABLE IF NOT EXISTS calibration_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_feedback_id INTEGER REFERENCES session_feedback(id),
      component TEXT NOT NULL,
      previous_value REAL NOT NULL,
      new_value REAL NOT NULL,
      reason TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    -- AI-generated weekly plans
    CREATE TABLE IF NOT EXISTS weekly_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      generated_at TEXT DEFAULT (datetime('now', 'localtime')),
      status TEXT DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_weekly_plans_week ON weekly_plans(week_start DESC);

    -- Weekly reckonings: end-of-week reflections + open questions + user responses
    CREATE TABLE IF NOT EXISTS weekly_reckonings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start TEXT NOT NULL,
      reckoning_text TEXT,
      open_question TEXT,
      response_text TEXT,
      response_received_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_weekly_reckonings_week ON weekly_reckonings(week_start DESC);
  `);

  // FTS5 full-text search over mem_facts (topic + content)
  // Uses external content table pattern so queries stay in sync via triggers.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS mem_facts_fts USING fts5(
      topic,
      content,
      category,
      content='mem_facts',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS mem_facts_fts_ai
    AFTER INSERT ON mem_facts BEGIN
      INSERT INTO mem_facts_fts(rowid, topic, content, category)
      VALUES (new.id, new.topic, new.content, new.category);
    END;

    CREATE TRIGGER IF NOT EXISTS mem_facts_fts_au
    AFTER UPDATE ON mem_facts BEGIN
      INSERT INTO mem_facts_fts(mem_facts_fts, rowid, topic, content, category)
      VALUES ('delete', old.id, old.topic, old.content, old.category);
      INSERT INTO mem_facts_fts(rowid, topic, content, category)
      VALUES (new.id, new.topic, new.content, new.category);
    END;

    CREATE TRIGGER IF NOT EXISTS mem_facts_fts_ad
    AFTER DELETE ON mem_facts BEGIN
      INSERT INTO mem_facts_fts(mem_facts_fts, rowid, topic, content, category)
      VALUES ('delete', old.id, old.topic, old.content, old.category);
    END;
  `);

  // daily_domain_aggregates: migration 010_data_pruning.sql creates and then drops this table
  // in the same file (-- Down section), so it doesn't exist on fresh installs. Ensure it exists here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_domain_aggregates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      domain TEXT NOT NULL,
      category TEXT DEFAULT 'neutral',
      total_duration INTEGER DEFAULT 0,
      created_at TEXT DEFAULT current_timestamp
    );
    CREATE INDEX IF NOT EXISTS idx_daily_domain_aggregates_date ON daily_domain_aggregates(date);
    CREATE INDEX IF NOT EXISTS idx_daily_domain_aggregates_category ON daily_domain_aggregates(category);
  `);

  // Daily check-in records: morning commitment + evening reflection responses
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_checkins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checkin_date TEXT NOT NULL,
      checkin_type TEXT NOT NULL CHECK(checkin_type IN ('morning','evening')),
      commitment TEXT,
      likelihood_score INTEGER,
      avoidance_honest TEXT,
      postponed_item TEXT,
      tomorrow_score INTEGER,
      tomorrow_reason TEXT,
      raw_transcript TEXT,
      memory_extracted INTEGER DEFAULT 0,
      received_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_daily_checkins_date ON daily_checkins(checkin_date DESC);
    CREATE INDEX IF NOT EXISTS idx_daily_checkins_type ON daily_checkins(checkin_type, checkin_date DESC);
  `);

  // Override follow-up tracking: 20-min post-override outcome questions
  db.exec(`
    CREATE TABLE IF NOT EXISTS override_follow_ups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      override_url TEXT NOT NULL,
      override_reason TEXT,
      follow_up_at TEXT NOT NULL,
      sent INTEGER DEFAULT 0,
      response TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_override_follow_ups_follow_up_at ON override_follow_ups(follow_up_at) WHERE sent = 0;
    CREATE INDEX IF NOT EXISTS idx_override_follow_ups_session ON override_follow_ups(session_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS screen_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observed_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'screenshot' CHECK(source IN ('screenshot','daemon','extension_screenshot','extension_daemon')),
      app TEXT,
      window_title TEXT,
      activity TEXT,
      category TEXT CHECK(category IN ('deep_work','shallow_work','communication','consumption','distraction','idle')),
      content_type TEXT,
      attention_quality TEXT CHECK(attention_quality IN ('focused','browsing','consuming','distracted','idle')),
      specific_content TEXT,
      productive_for_goals INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0.8,
      session_id TEXT REFERENCES guardian_sessions(session_id),
      raw_description TEXT
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_screen_obs_observed_at ON screen_observations(observed_at DESC)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS phone_screen_time (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT NOT NULL,
      report_type TEXT NOT NULL CHECK(report_type IN ('morning','midday','evening','manual')),
      total_minutes INTEGER,
      instagram_minutes INTEGER,
      youtube_minutes INTEGER,
      tiktok_minutes INTEGER,
      safari_minutes INTEGER,
      other_data TEXT,
      pickup_count INTEGER,
      first_pickup_time TEXT,
      longest_phone_free_minutes INTEGER,
      raw_text TEXT,
      received_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

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
    // Telegram
    telegram_bot_token: '',
    telegram_chat_id: '',
    telegram_enabled: 'true',
    // Google Calendar
    google_calendar_refresh_token: '',
    google_calendar_id: 'primary',
    google_calendar_enabled: 'true',
    // Resend email
    resend_api_key: '',
    notification_email: '',
    email_alerts_enabled: 'true',
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
