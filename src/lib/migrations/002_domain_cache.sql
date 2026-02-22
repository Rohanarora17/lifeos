CREATE TABLE IF NOT EXISTS domain_categories (
    domain TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK(category IN ('productive', 'distraction', 'neutral')),
    subcategory TEXT DEFAULT 'other',
    confidence REAL DEFAULT 0.0,
    ai_reasoning TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_domain_categories_cat ON domain_categories(category);
