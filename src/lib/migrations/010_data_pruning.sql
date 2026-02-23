-- Up
CREATE TABLE IF NOT EXISTS daily_domain_aggregates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    domain TEXT NOT NULL,
    category TEXT DEFAULT 'neutral',
    total_duration INTEGER DEFAULT 0,
    created_at TEXT DEFAULT current_timestamp
);

-- Index for fast time-series queries
CREATE INDEX IF NOT EXISTS idx_daily_domain_aggregates_date ON daily_domain_aggregates(date);
CREATE INDEX IF NOT EXISTS idx_daily_domain_aggregates_category ON daily_domain_aggregates(category);

-- Down
DROP TABLE IF EXISTS daily_domain_aggregates;
