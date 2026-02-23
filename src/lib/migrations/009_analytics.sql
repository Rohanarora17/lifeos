-- Phase 17: Advanced AI Analytics & Correlation Engine

CREATE TABLE IF NOT EXISTS ai_insights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  insight TEXT NOT NULL,
  type TEXT NOT NULL, -- 'correlation', 'warning', 'praise'
  created_at TEXT DEFAULT (datetime('now'))
);
