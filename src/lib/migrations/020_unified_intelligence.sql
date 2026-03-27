-- Unified Intelligence Layer
-- Persists per-session domain classifications so server restarts don't lose
-- context-aware results (e.g. YouTube = on_topic during a lecture session).
CREATE TABLE IF NOT EXISTS session_domain_classifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  classification TEXT NOT NULL CHECK(classification IN ('on_topic','distraction','unknown')),
  classified_at INTEGER NOT NULL,
  UNIQUE(session_id, domain)
);

-- DB-backed domain configuration — replaces hardcoded arrays in extension/background.js
-- and guardian-classifier.ts. Seeded from those arrays; user-editable going forward.
CREATE TABLE IF NOT EXISTS privacy_blocked_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT UNIQUE NOT NULL,
  reason TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS context_sensitive_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT UNIQUE NOT NULL,
  reason TEXT,
  is_active INTEGER DEFAULT 1
);

-- Seed privacy-blocked domains (from extension/background.js PRIVACY_BLOCKED_DOMAINS)
INSERT OR IGNORE INTO privacy_blocked_domains (domain, reason) VALUES
  ('chase.com', 'financial'),
  ('bankofamerica.com', 'financial'),
  ('wellsfargo.com', 'financial'),
  ('fidelity.com', 'financial'),
  ('paypal.com', 'financial'),
  ('venmo.com', 'financial'),
  ('robinhood.com', 'financial'),
  ('coinbase.com', 'financial'),
  ('mychart.com', 'health'),
  ('myhealth.va.gov', 'health'),
  ('patient.info', 'health'),
  ('accounts.google.com', 'auth'),
  ('login.microsoftonline.com', 'auth'),
  ('auth0.com', 'auth'),
  ('web.whatsapp.com', 'messaging'),
  ('web.telegram.org', 'messaging');

-- Seed context-sensitive domains (from guardian-classifier.ts CONTEXT_SENSITIVE_DOMAINS)
INSERT OR IGNORE INTO context_sensitive_domains (domain, reason) VALUES
  ('youtube.com', 'video'),
  ('youtu.be', 'video'),
  ('vimeo.com', 'video'),
  ('dailymotion.com', 'video'),
  ('twitch.tv', 'streaming'),
  ('kick.com', 'streaming'),
  ('twitter.com', 'social'),
  ('x.com', 'social'),
  ('reddit.com', 'social'),
  ('discord.com', 'social'),
  ('slack.com', 'work_comms'),
  ('linkedin.com', 'professional'),
  ('notion.so', 'productivity'),
  ('figma.com', 'design');
