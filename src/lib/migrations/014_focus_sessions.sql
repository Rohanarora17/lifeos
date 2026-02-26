-- Focus Sessions table for tracking dedicated focus work periods
CREATE TABLE IF NOT EXISTS focus_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER,
    goal_title TEXT,
    task_id INTEGER,
    task_title TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_minutes INTEGER,
    actual_duration_seconds INTEGER,
    productive_seconds INTEGER DEFAULT 0,
    distraction_seconds INTEGER DEFAULT 0,
    neutral_seconds INTEGER DEFAULT 0,
    tabs_opened INTEGER DEFAULT 0,
    tabs_blocked INTEGER DEFAULT 0,
    tabs_overridden INTEGER DEFAULT 0,
    top_domains TEXT,
    ai_report TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT current_timestamp
);
