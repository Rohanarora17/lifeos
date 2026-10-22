ALTER TABLE endsem_config ADD COLUMN conversational_mode INTEGER NOT NULL DEFAULT 0 CHECK(conversational_mode IN (0,1));
CREATE TABLE study_chat_days (
  date TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  pending_json TEXT,
  preferred_subject TEXT CHECK(preferred_subject IN ('probability','adsa')),
  wake_at TEXT,
  day_end_at TEXT,
  plan_json TEXT,
  calendar_json TEXT
);
CREATE TABLE study_activities (
  id TEXT PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL, started_at TEXT NOT NULL, expected_return_at TEXT,
  status TEXT NOT NULL, revision INTEGER NOT NULL,
  calendar_event_id TEXT
);
CREATE INDEX idx_study_activities_date ON study_activities(date,status);
CREATE TABLE study_chat_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT NOT NULL,
  request_id TEXT, created_at TEXT NOT NULL,
  UNIQUE(request_id,role)
);
CREATE TABLE study_chat_requests (
  request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
  expected_revision INTEGER NOT NULL, reply TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE study_chat_prompts (
  id TEXT PRIMARY KEY, prompt_key TEXT NOT NULL UNIQUE, date TEXT NOT NULL,
  activity_id TEXT, session_id TEXT, revision INTEGER NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
  displayed_at TEXT, resolved_at TEXT, device_id TEXT
);
CREATE TABLE study_class_attendance (
  id TEXT PRIMARY KEY, calendar_event_id TEXT NOT NULL UNIQUE,
  subject TEXT NOT NULL CHECK(subject IN ('probability','adsa')),
  attended_start TEXT NOT NULL, attended_end TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'self_reported', request_id TEXT NOT NULL UNIQUE,
  calendar_snapshot TEXT NOT NULL, created_at TEXT NOT NULL
);
