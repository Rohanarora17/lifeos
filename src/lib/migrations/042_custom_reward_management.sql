-- Distinguish the seeded catalog from rewards created by the user so the UI can
-- safely allow editing and deletion without exposing system defaults.

ALTER TABLE rewards_store ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0;

-- The original catalog owns stable ids 1-4. Any later rows pre-date this flag
-- and were created through the custom reward form.
UPDATE rewards_store
SET is_custom = 1
WHERE id NOT IN (1, 2, 3, 4);

UPDATE rewards_store SET category = 'leisure' WHERE id IN (1, 2) AND is_custom = 0;
UPDATE rewards_store SET category = 'purchase' WHERE id = 3 AND is_custom = 0;
UPDATE rewards_store SET category = 'escape' WHERE id = 4 AND is_custom = 0;

CREATE INDEX IF NOT EXISTS idx_rewards_store_custom ON rewards_store(is_custom, created_at DESC);
