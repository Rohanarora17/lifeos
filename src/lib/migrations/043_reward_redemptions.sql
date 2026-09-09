-- Immutable reward-purchase snapshots make coin deductions auditable and make
-- client retries safe. Reward definitions may later be edited or deleted.

CREATE TABLE IF NOT EXISTS reward_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  reward_id INTEGER NOT NULL,
  reward_title TEXT NOT NULL,
  reward_icon TEXT NOT NULL DEFAULT '🎁',
  cost INTEGER NOT NULL CHECK(cost > 0),
  category TEXT DEFAULT 'custom',
  pricing_json TEXT DEFAULT '{}',
  adaptive_reason TEXT DEFAULT NULL,
  ledger_entry_id INTEGER NOT NULL UNIQUE REFERENCES coin_ledger(id) ON DELETE CASCADE,
  redeemed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reward_redemptions_reward
  ON reward_redemptions(reward_id, redeemed_at DESC);

CREATE INDEX IF NOT EXISTS idx_reward_redemptions_redeemed_at
  ON reward_redemptions(redeemed_at DESC);
