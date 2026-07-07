-- Adaptive reward pricing: user rewards can be priced by policy instead of fixed manual costs.

ALTER TABLE rewards_store ADD COLUMN category TEXT DEFAULT 'custom';
ALTER TABLE rewards_store ADD COLUMN pricing_json TEXT DEFAULT '{}';
ALTER TABLE rewards_store ADD COLUMN adaptive_reason TEXT DEFAULT NULL;
ALTER TABLE rewards_store ADD COLUMN user_cost_override INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_rewards_store_category ON rewards_store(category, cost);
